import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import type { TerminalWaiter } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeTerminalWait } from '../../shared/runtime-types'

const INTERVAL_MS = 2000

function makePty(ptyId: string, overrides: Partial<RuntimePtyWorktreeRecord> = {}) {
  return {
    ptyId,
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastOutputAt: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  } as unknown as RuntimePtyWorktreeRecord
}

function makeLeaf(tabId: string, overrides: Partial<RuntimeLeafRecord> = {}) {
  return {
    tabId,
    ptyId: `${tabId}-pty`,
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastOutputAt: null,
    paneTitle: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  } as unknown as RuntimeLeafRecord
}

function makeWaiter(handle: string): TerminalWaiter {
  return {
    handle,
    condition: 'tui-idle',
    resolve: () => {},
    reject: () => {},
    timeout: null,
    cancelIdlePoll: null,
    abortCleanup: null
  }
}

describe('RuntimeTerminalIdlePolls timer budget', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
  })

  afterEach(() => {
    setIntervalSpy.mockRestore()
    vi.useRealTimers()
  })

  it('allocates one interval for 20 concurrent waiters and still resolves them on the first tick', () => {
    const resolved: { handle: string; result: RuntimeTerminalWait }[] = []
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: 1500,
      getTabTitle: () => null,
      getForegroundProcess: () => null,
      getAdoptedPtyIdleStatus: () => null,
      resolve: (waiter, result) => resolved.push({ handle: waiter.handle, result })
    })

    const waiters = Array.from({ length: 20 }, (_, index) => {
      const waiter = makeWaiter(`handle-${index}`)
      // Already idle: an independent interval would have resolved this on its own
      // first tick at exactly intervalMs, and so must the shared sweep.
      polls.startPty(waiter, makePty(`pty-${index}`, { lastAgentStatus: 'idle' }))
      return waiter
    })

    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(polls.activeTimerCount).toBe(1)
    expect(resolved).toHaveLength(0)

    vi.advanceTimersByTime(INTERVAL_MS - 1)
    expect(resolved).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(resolved.map((entry) => entry.handle)).toEqual(waiters.map((waiter) => waiter.handle))
    // Every waiter retired, so the shared timer must retire with them.
    expect(polls.activeTimerCount).toBe(0)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps one interval across mixed leaf and pty waiters and re-arms after going idle', () => {
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: 1500,
      getTabTitle: () => null,
      getForegroundProcess: () => null,
      getAdoptedPtyIdleStatus: () => null,
      resolve: () => {}
    })

    for (let index = 0; index < 10; index += 1) {
      polls.startPty(makeWaiter(`pty-handle-${index}`), makePty(`pty-${index}`))
      polls.startLeaf(makeWaiter(`leaf-handle-${index}`), makeLeaf(`tab-${index}`))
    }
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(INTERVAL_MS * 5)
    // Nothing resolved: still exactly one live handle after 5 sweeps.
    expect(polls.activeTimerCount).toBe(1)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('retires the shared timer when the last waiter is cancelled through the waiter record', () => {
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: 1500,
      getTabTitle: () => null,
      getForegroundProcess: () => null,
      getAdoptedPtyIdleStatus: () => null,
      resolve: () => {}
    })
    const first = makeWaiter('a')
    const second = makeWaiter('b')
    polls.startPty(first, makePty('pty-a'))
    polls.startPty(second, makePty('pty-b'))

    first.cancelIdlePoll?.()
    expect(first.cancelIdlePoll).toBeNull()
    expect(polls.activeTimerCount).toBe(1)

    second.cancelIdlePoll?.()
    expect(polls.activeTimerCount).toBe(0)
  })

  it('runs the foreground read per waiter without one waiter blocking another', async () => {
    const resolved: string[] = []
    const gates: ((value: string | null) => void)[] = []
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: 1500,
      getTabTitle: () => null,
      getForegroundProcess: () =>
        new Promise<string | null>((resolve) => {
          gates.push(resolve)
        }),
      getAdoptedPtyIdleStatus: () => null,
      resolve: (waiter) => resolved.push(waiter.handle)
    })

    polls.startPty(makeWaiter('slow'), makePty('pty-slow', { lastOutputAt: Date.now() - 10_000 }))
    polls.startPty(makeWaiter('fast'), makePty('pty-fast', { lastOutputAt: Date.now() - 10_000 }))

    vi.advanceTimersByTime(INTERVAL_MS)
    // Both waiters issued their read in the same sweep — a sequential sweep would
    // have blocked the second behind the first's unresolved promise.
    expect(gates).toHaveLength(2)

    gates[1]('node')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual(['fast'])

    gates[0]('node')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual(['fast', 'slow'])
    expect(polls.activeTimerCount).toBe(0)
  })
})

describe('RuntimeTerminalIdlePolls name-only idle corroboration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Quiescence longer than the sweep interval, so one sweep can observe output that is
  // still too fresh to corroborate anything.
  const CORROBORATION_QUIESCENCE_MS = 5000

  function createPolls(options: { foreground: string | null; resolved: string[] }) {
    return new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: CORROBORATION_QUIESCENCE_MS,
      getTabTitle: () => null,
      getForegroundProcess: () => Promise.resolve(options.foreground),
      getAdoptedPtyIdleStatus: () => null,
      resolve: (waiter) => options.resolved.push(waiter.handle)
    })
  }

  // #6011: the poll used to accept any stored 'idle', so a name-only title resolved
  // on the first sweep no matter how recently the agent had written output.
  it('holds a name-only idle pty while its output is still streaming', async () => {
    const resolved: string[] = []
    const polls = createPolls({ foreground: 'codex', resolved })
    const pty = makePty('pty-name-only', {
      lastAgentStatus: 'idle',
      lastAgentIdleEvidence: 'name-only',
      lastOutputAt: Date.now()
    })

    polls.startPty(makeWaiter('name-only'), pty)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    expect(resolved).toEqual([])
  })

  it('settles a name-only idle pty once quiescence corroborates it', async () => {
    const resolved: string[] = []
    const polls = createPolls({ foreground: 'codex', resolved })
    const pty = makePty('pty-name-only', {
      lastAgentStatus: 'idle',
      lastAgentIdleEvidence: 'name-only',
      lastOutputAt: Date.now() - 10_000
    })

    polls.startPty(makeWaiter('name-only'), pty)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    expect(resolved).toEqual(['name-only'])
  })

  it('holds a name-only idle leaf whose foreground is back to the shell', async () => {
    const resolved: string[] = []
    const polls = createPolls({ foreground: 'bash', resolved })
    const leaf = makeLeaf('tab-name-only', {
      lastAgentStatus: 'idle',
      lastAgentIdleEvidence: 'name-only',
      lastOutputAt: Date.now() - 10_000
    })

    polls.startLeaf(makeWaiter('name-only-leaf'), leaf)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    expect(resolved).toEqual([])
  })

  it('settles an explicitly reported idle on the first sweep', async () => {
    const resolved: string[] = []
    const polls = createPolls({ foreground: null, resolved })
    const pty = makePty('pty-explicit', {
      lastAgentStatus: 'idle',
      lastAgentIdleEvidence: 'explicit',
      lastOutputAt: Date.now()
    })

    polls.startPty(makeWaiter('explicit'), pty)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    expect(resolved).toEqual(['explicit'])
  })
})
