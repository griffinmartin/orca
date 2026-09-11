import type { AgentStatus, AgentTitleIdleEvidence } from '../../shared/agent-detection'

/**
 * Reading a stored `lastAgentStatus` as settlement evidence.
 *
 * Why: the shared title detector reports `idle` for a title that carries nothing
 * but a recognized agent NAME, because the sidebar and `worktree ps` need that to
 * clear a stale spinner. A busy Codex/Devin pane emits exactly such a title, so
 * accepting it as `tui-idle` satisfied a wait in ~0s while the agent was mid-turn
 * (#6011). Provenance is stamped next to the status at write time; these
 * predicates are the only place that reads it back.
 */
type StoredAgentStatusRecord = {
  lastAgentStatus: AgentStatus | null
  lastAgentIdleEvidence?: AgentTitleIdleEvidence | null
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
