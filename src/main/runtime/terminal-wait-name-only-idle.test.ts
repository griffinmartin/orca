import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import { RuntimeTerminalWait } from './runtime-terminal-wait'
import { RuntimeTerminalWaiterRegistry } from './runtime-terminal-waiter-registry'
import { detectAgentTitleIdleEvidence } from '../../shared/agent-detection'
import type { AgentStatus } from '../../shared/agent-detection'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

// #6011: `terminal wait --for tui-idle` returned satisfied in ~0s against a working agent,
// because a Codex/Devin OSC title that carries only the agent NAME is stored as `idle` and
// the wait accepted the stored value. The name is not a turn signal; these tests pin which
// evidence settles the wait and which only corroborates.

const POLL_INTERVAL_MS = 2000
const QUIESCENCE_MS = 3000
const NAME_ONLY_TITLE = 'Codex'
const EXPLICIT_IDLE_TITLE = 'Codex ready'
const HANDLE = 'terminal-1'

function stampIdleFromTitle(title: string): {
  lastAgentStatus: AgentStatus | null
  lastAgentIdleEvidence: ReturnType<typeof detectAgentTitleIdleEvidence>
} {
  // Mirrors what applyTrackedPtyTitle writes, so the fixtures cannot drift from the producer.
  return { lastAgentStatus: 'idle', lastAgentIdleEvidence: detectAgentTitleIdleEvidence(title) }
}

function makePty(overrides: Partial<RuntimePtyWorktreeRecord> = {}): RuntimePtyWorktreeRecord {
  return {
    ptyId: 'pty-1',
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastAgentIdleEvidence: null,
    lastOutputAt: Date.now(),
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  } as unknown as RuntimePtyWorktreeRecord
}

function makeLeaf(overrides: Partial<RuntimeLeafRecord> = {}): RuntimeLeafRecord {
  return {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastAgentIdleEvidence: null,
    lastOutputAt: Date.now(),
    paneTitle: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  } as unknown as RuntimeLeafRecord
}

function createWait(options: {
  pty?: RuntimePtyWorktreeRecord
  leaf?: RuntimeLeafRecord
  adoptedIdleStatus?: AgentStatus | null
  tabTitle?: string | null
  foreground?: string | null
}) {
  const waiters = new RuntimeTerminalWaiterRegistry()
  const startVisibleReadProbe = vi.fn()
  const polls = new RuntimeTerminalIdlePolls({
    intervalMs: POLL_INTERVAL_MS,
    quiescenceMs: QUIESCENCE_MS,
    getTabTitle: () => options.tabTitle ?? null,
    getForegroundProcess: () => Promise.resolve(options.foreground ?? null),
    getAdoptedPtyIdleStatus: () => options.adoptedIdleStatus ?? null,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      defaultTimeoutMs: 60_000,
      getLivePty: () => (options.pty ? { pty: options.pty } : null),
      getLiveLeaf: () => ({ leaf: options.leaf ?? makeLeaf() }),
      getAdoptedPtyIdleStatus: () => options.adoptedIdleStatus ?? null,
      getTabTitle: () => options.tabTitle ?? null,
      startVisibleReadProbe
    },
    waiters,
    polls
  )
  return { wait, waiters, polls, startVisibleReadProbe }
}

function watch(promise: Promise<unknown>) {
  const settled = vi.fn()
  void promise.then(
    (value) => settled({ ok: value }),
    (error) => settled({ error: (error as Error).message })
  )
  return settled
}

/** Keeps the record "streaming": output stays younger than the quiescence window. */
async function advanceWhileStreaming(
  record: { lastOutputAt: number | null },
  ticks: number
): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    record.lastOutputAt = Date.now()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  }
}

describe('tui-idle refuses a name-only agent title', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves a streaming pty unsatisfied, then settles on the explicit idle title', async () => {
    const pty = makePty(stampIdleFromTitle(NAME_ONLY_TITLE))
    const { wait } = createWait({ pty, foreground: 'codex' })

    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await advanceWhileStreaming(pty, 4)
    expect(settled).not.toHaveBeenCalled()

    Object.assign(pty, stampIdleFromTitle(EXPLICIT_IDLE_TITLE))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(settled).toHaveBeenCalledWith({ ok: expect.objectContaining({ satisfied: true }) })
  })

  it('leaves a streaming leaf unsatisfied, then settles on the explicit idle title', async () => {
    const leaf = makeLeaf(stampIdleFromTitle(NAME_ONLY_TITLE))
    const { wait } = createWait({ leaf, foreground: 'codex' })

    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await advanceWhileStreaming(leaf, 4)
    expect(settled).not.toHaveBeenCalled()

    Object.assign(leaf, stampIdleFromTitle(EXPLICIT_IDLE_TITLE))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(settled).toHaveBeenCalledWith({ ok: expect.objectContaining({ satisfied: true }) })
  })

  it('settles a name-only pty on quiescence corroborated by a live non-shell foreground', async () => {
    const pty = makePty(stampIdleFromTitle(NAME_ONLY_TITLE))
    const { wait } = createWait({ pty, foreground: 'codex' })

    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await advanceWhileStreaming(pty, 2)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(settled).toHaveBeenCalledWith({ ok: expect.objectContaining({ satisfied: true }) })
  })

  it('never settles a name-only pane on quiescence alone when the agent left the foreground', async () => {
    const pty = makePty({ ...stampIdleFromTitle(NAME_ONLY_TITLE), lastOutputAt: 1 })
    const { wait } = createWait({ pty, foreground: 'bash' })

    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)

    expect(settled).not.toHaveBeenCalled()
  })

  it('still satisfies immediately on an explicitly reported idle', async () => {
    const pty = makePty(stampIdleFromTitle(EXPLICIT_IDLE_TITLE))
    const { wait } = createWait({ pty })

    await expect(wait.wait(HANDLE, { condition: 'tui-idle' })).resolves.toMatchObject({
      satisfied: true,
      condition: 'tui-idle'
    })
  })

  it('still satisfies immediately on a stored idle that predates the evidence stamp', async () => {
    // A seeded, mirrored, or restored record carries no stamp; it keeps its prior meaning.
    const pty = makePty({ lastAgentStatus: 'idle', lastAgentIdleEvidence: undefined })
    const { wait } = createWait({ pty })

    await expect(wait.wait(HANDLE, { condition: 'tui-idle' })).resolves.toMatchObject({
      satisfied: true
    })
  })

  it('still satisfies an adopted pane from its explicit tab title while the record is name-only', async () => {
    const pty = makePty(stampIdleFromTitle(NAME_ONLY_TITLE))
    const { wait } = createWait({ pty, adoptedIdleStatus: 'idle' })

    await expect(wait.wait(HANDLE, { condition: 'tui-idle' })).resolves.toMatchObject({
      satisfied: true
    })
  })

  it('still satisfies on the explicit Codex ready banner while the record is name-only', async () => {
    const pty = makePty({
      ...stampIdleFromTitle(NAME_ONLY_TITLE),
      preview: 'OpenAI Codex\nmodel: gpt-5\ndirectory: /repo\n'
    })
    const { wait } = createWait({ pty })

    await expect(wait.wait(HANDLE, { condition: 'tui-idle' })).resolves.toMatchObject({
      satisfied: true
    })
  })

  it('reports the permission prompt as blocked rather than idle', async () => {
    const pty = makePty({
      ...stampIdleFromTitle(NAME_ONLY_TITLE),
      preview: 'codex wants to run a command\npermission required\nallow once\nallow always\n'
    })
    const { wait } = createWait({ pty })

    // Why the pattern and not the literal: this reason is mid-rename from the Codex-specific
    // spelling to the agent-neutral one, and either spelling proves the same thing here.
    await expect(wait.wait(HANDLE, { condition: 'tui-idle' })).resolves.toMatchObject({
      satisfied: false,
      blockedReason: expect.stringMatching(/interactive-prompt$/)
    })
  })
})

const E2E_WORKTREE_ID = 'repo-1::/tmp/name-only-idle'
const E2E_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const E2E_PTY_ID = 'pty-name-only-idle'
const WORKING_TITLE = '⠋ Codex'

function makeStore() {
  return {
    getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/name-only-idle',
        displayName: 'name-only-idle',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

async function makeRuntime() {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: vi.fn(() => true),
    kill: () => true,
    // The agent process stays in the foreground; only its output and title move.
    getForegroundProcess: async () => 'codex',
    listProcesses: vi.fn(async () => []),
    hasPty: () => true
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: E2E_WORKTREE_ID,
        title: 'Agent',
        activeLeafId: E2E_LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: E2E_WORKTREE_ID,
        leafId: E2E_LEAF_ID,
        paneRuntimeId: 1,
        ptyId: E2E_PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  })
  const { terminals } = await runtime.listTerminals(`id:${E2E_WORKTREE_ID}`)
  return { runtime, handle: terminals[0].handle }
}

function oscTitle(title: string): string {
  return `]0;${title}`
}

describe('tui-idle over the live OSC title pipeline', () => {
  it('does not settle the working-to-idle callback on a name-only title mid-stream', async () => {
    const { runtime, handle } = await makeRuntime()
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(WORKING_TITLE)}building\n`, Date.now())

    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 250 })
    // The agent is mid-turn and repaints its title to the bare product name.
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}more output\n`, Date.now())

    await expect(waiting).rejects.toThrow('timeout')
  })

  it('settles the working-to-idle callback when the agent reports idle explicitly', async () => {
    const { runtime, handle } = await makeRuntime()
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(WORKING_TITLE)}building\n`, Date.now())

    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}more output\n`, Date.now())
    runtime.onPtyData(E2E_PTY_ID, oscTitle(EXPLICIT_IDLE_TITLE), Date.now())

    await expect(waiting).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
  })

  it('refuses a name-only title observed before the waiter registered', async () => {
    const { runtime, handle } = await makeRuntime()
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}output\n`, Date.now())

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 250 })
    ).rejects.toThrow('timeout')
  })
})
