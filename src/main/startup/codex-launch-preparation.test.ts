import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type * as AgentStatusHooksEnablement from '../agent-hooks/agent-status-hooks-enablement'

/**
 * Per-pane launch prep must be install-only against the user-global real ~/.codex (STA-5679):
 * passing the off switch through routes to a sweep that matches Orca-managed entries by script
 * filename, so a second profile's first hooks-off Codex spawn deletes the primary profile's hook
 * and its trust records. Startup already gates this way; these drive the pane twin.
 */
const {
  ensureRealHomeCodexHookStateMock,
  markCodexProjectTrustedMock,
  prepareRuntimeHomeForLaunchMock,
  runtimeHomeFake,
  mainProcessStateFake
} = vi.hoisted(() => {
  const runtimeHomeFake = {
    isHostSystemDefaultRealHomeSelected: vi.fn(() => true),
    prepareForCodexLaunchAsync: vi.fn(async () => null as string | null)
  }
  return {
    ensureRealHomeCodexHookStateMock: vi.fn(async () => undefined),
    markCodexProjectTrustedMock: vi.fn(async () => undefined),
    prepareRuntimeHomeForLaunchMock: vi.fn(async () => ({ state: 'ok' as const })),
    runtimeHomeFake,
    mainProcessStateFake: {
      store: null as { getSettings: () => GlobalSettings } | null,
      codexRuntimeHome: runtimeHomeFake as typeof runtimeHomeFake | null
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/orca-codex-launch-prep-test') }
}))
vi.mock('../agent-trust-presets', () => ({
  markCodexProjectTrusted: markCodexProjectTrustedMock
}))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: prepareRuntimeHomeForLaunchMock }
}))
vi.mock('../wsl', () => ({ getDefaultWslDistro: vi.fn(() => 'Ubuntu') }))
vi.mock('../codex/codex-real-home-hook-install', () => ({
  ensureRealHomeCodexHookState: ensureRealHomeCodexHookStateMock
}))
// The real controls module drags in every per-agent hook service; the off-switch predicate itself
// lives in a registry-free module, so it stays real — the gate under test must read a real answer.
vi.mock('../agent-hooks/managed-agent-hook-controls', async () => {
  const enablement = await vi.importActual<typeof AgentStatusHooksEnablement>(
    '../agent-hooks/agent-status-hooks-enablement'
  )
  return { isAgentStatusHooksEnabled: enablement.isAgentStatusHooksEnabled }
})
vi.mock('./main-process-state', () => ({ mainProcessState: mainProcessStateFake }))

import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'

function setHooksEnabled(agentStatusHooksEnabled: boolean): void {
  mainProcessStateFake.store = {
    getSettings: vi.fn(() => ({ agentStatusHooksEnabled }) as unknown as GlobalSettings)
  }
}

describe('prepareCodexRuntimeHomeForLaunch real-home hook preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mainProcessStateFake.codexRuntimeHome = runtimeHomeFake
    runtimeHomeFake.isHostSystemDefaultRealHomeSelected.mockReturnValue(true)
    runtimeHomeFake.prepareForCodexLaunchAsync.mockResolvedValue(null)
    prepareRuntimeHomeForLaunchMock.mockResolvedValue({ state: 'ok' as const })
  })

  it('never touches the user-global real home when the off switch is set', async () => {
    setHooksEnabled(false)

    await prepareCodexRuntimeHomeForLaunch(
      undefined,
      {},
      {
        launchAgent: 'codex',
        workspacePath: '/repo'
      }
    )

    // Reaching the installer at all with hooks off sweeps entries another profile wrote.
    expect(ensureRealHomeCodexHookStateMock).not.toHaveBeenCalled()
  })

  it('installs into the real home with a hard enable when the switch is on', async () => {
    setHooksEnabled(true)

    await prepareCodexRuntimeHomeForLaunch(
      undefined,
      {},
      {
        launchAgent: 'codex',
        workspacePath: '/repo'
      }
    )

    expect(ensureRealHomeCodexHookStateMock).toHaveBeenCalledTimes(1)
    expect(ensureRealHomeCodexHookStateMock).toHaveBeenCalledWith({
      hooksEnabled: true,
      userDataPath: '/tmp/orca-codex-launch-prep-test'
    })
  })

  it('leaves the real home alone on a WSL launch even with the switch on', async () => {
    setHooksEnabled(true)
    runtimeHomeFake.prepareForCodexLaunchAsync.mockResolvedValue('/wsl/codex-home')

    await prepareCodexRuntimeHomeForLaunch(
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      {},
      {
        launchAgent: 'codex',
        workspacePath: '/repo'
      }
    )

    expect(ensureRealHomeCodexHookStateMock).not.toHaveBeenCalled()
    expect(markCodexProjectTrustedMock).not.toHaveBeenCalled()
  })
})
