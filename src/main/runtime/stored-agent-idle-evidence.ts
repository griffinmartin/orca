import type { AgentStatus, AgentTitleIdleEvidence } from '../../shared/agent-detection'
import { getSyntheticAgentTerminalTitle } from '../../shared/synthetic-agent-title'
import type { TuiAgent } from '../../shared/tui-agent'

/**
 * What counts as idle evidence strong enough to settle a `tui-idle` wait.
 *
 * Why: the shared title detector reports `idle` for a title that carries nothing
 * but a recognized agent NAME, because the sidebar and `worktree ps` need that to
 * clear a stale spinner. A busy Codex/Devin pane emits exactly such a title, so
 * accepting it as `tui-idle` satisfied a wait in ~0s while the agent was mid-turn
 * (#6011). The grade is computed next to the status at write time; these
 * predicates are the only place that reads it back.
 */
type StoredAgentStatusRecord = {
  lastAgentStatus: AgentStatus | null
  lastAgentIdleEvidence?: AgentTitleIdleEvidence | null
}

/**
 * Whether a name-only title from `agent` may be demoted to "needs corroboration".
 *
 * Only for agents that will later announce rest with an explicit title of their own
 * (`Codex ready`, `Devin ready`, …) via the hook-driven synthetic title. Everything
 * else — Grok, Copilot, Aider, Mimo, agy, OpenCode — emits its NAME and nothing more
 * at rest, so demoting it leaves the pane with no settle signal at all. Measured:
 * a real idle Grok pane repaints its banner about four times a second forever, so
 * the output-quiescence lane never fires and the wait runs to timeout.
 */
export function nameOnlyIdleNeedsCorroboration(agent: TuiAgent | null | undefined): boolean {
  return getSyntheticAgentTerminalTitle(agent, 'done') !== null
}

/** Idle the agent asserted with its own marker — enough on its own to settle a wait. */
export function hasPositiveStoredIdleEvidence(record: StoredAgentStatusRecord): boolean {
  // Why `!== 'name-only'` rather than `=== 'explicit'`: an unstamped record predates
  // this channel (seeded, mirrored, or restored), and must keep its prior meaning.
  return record.lastAgentStatus === 'idle' && record.lastAgentIdleEvidence !== 'name-only'
}

/** Idle inferred from the agent's name alone — needs corroboration before it settles. */
export function hasNameOnlyStoredIdleEvidence(record: StoredAgentStatusRecord): boolean {
  return record.lastAgentStatus === 'idle' && record.lastAgentIdleEvidence === 'name-only'
}
