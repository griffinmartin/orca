import {
  AGY_AGENT_NAME_RE,
  BRAILLE_SPINNER_RE,
  CLAUDE_IDLE,
  CURSOR_NATIVE_TITLE_LOWER,
  DROID_AGENT_NAME_RE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  HERMES_AGENT_NAME_RE,
  QUARTER_CIRCLE_SPINNER_RE,
  STRONG_IDLE_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE_GLOBAL,
  containsAgentName,
  containsAgentSpinnerGlyph,
  containsAny,
  containsQuarterCircleSpinner,
  containsLegacyAgentName,
  isClaudeManagementTitle,
  isGeminiTerminalTitle,
  isPiAgentTitle,
  isPiTerminalTitle
} from './agent-title-core'
import type { AgentStatus } from './agent-title-core'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import {
  getPiCompatibleTitleSeparatorStatus,
  getPiCompatibleSyntheticAgentStatus
} from './pi-compatible-synthetic-title'
import { clearPiStateWorkingMarker, getPiStateTitleStatus } from './pi-state-title-marker'
import { getWrapperTitleSegments } from './terminal-title-wrapper-segments'
import { isGrokRotatingWorkingTitle } from './terminal-title-agent-type'
import { memoizeTitleClassification } from './terminal-title-classification-memo'

/**
 * Strip working-status indicators so stale exit titles stop reporting working.
 */
export function clearWorkingIndicators(title: string): string {
  // Why: Pi/OMP's static working marker survives every strip below, so a stale native
  // title would keep re-arming the 3s clear timer without ever leaving working (#13890).
  const clearedPiStateMarker = clearPiStateWorkingMarker(title)
  if (clearedPiStateMarker) {
    return clearedPiStateMarker
  }

  let cleaned = title

  cleaned = cleaned.replace(GEMINI_WORKING, '')
  cleaned = cleaned.replace(GEMINI_SILENT_WORKING, '')
  cleaned = cleaned.replace(BRAILLE_SPINNER_RE, '')
  cleaned = cleaned.replace(QUARTER_CIRCLE_SPINNER_RE, '')
  if (cleaned.startsWith('. ')) {
    cleaned = cleaned.slice(2)
  }
  if (containsAgentName(cleaned)) {
    cleaned = cleaned.replace(STRONG_WORKING_KEYWORDS_RE_GLOBAL, '')
  }

  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim()
  return cleaned || title
}

/**
 * Tracks agent status transitions from terminal title changes.
 */
export function createAgentStatusTracker(
  onBecameIdle: (title: string) => void,
  onBecameWorking?: () => void,
  onAgentExited?: () => void,
  initialTitle?: string
): {
  handleTitle: (title: string) => void
  seedTitle: (title: string) => void
  restoreLastExit: (confirmedStatus?: AgentStatus) => AgentStatus | null
  reset: () => void
} {
  // Why: trackers restored mid-session need a last-known status without firing
  // callbacks, or a hidden working agent can miss its later idle transition.
  let lastStatus: AgentStatus | null =
    initialTitle !== undefined ? detectAgentStatusFromTitle(initialTitle) : null
  let restorableExitStatus: AgentStatus | null = null

  return {
    handleTitle(title: string): void {
      const newStatus = detectAgentStatusFromTitle(title)
      if (newStatus !== null) {
        restorableExitStatus = null
      }
      if (lastStatus === 'working' && newStatus !== null && newStatus !== 'working') {
        onBecameIdle(title)
      }
      if (lastStatus !== 'working' && newStatus === 'working') {
        onBecameWorking?.()
      }
      // Why: reverting to a plain shell prompt after idle/permission means the
      // agent exited; while working it can just be a transient internal title.
      if (lastStatus !== null && lastStatus !== 'working' && newStatus === null) {
        restorableExitStatus = lastStatus
        lastStatus = null
        onAgentExited?.()
      }
      if (newStatus !== null) {
        lastStatus = newStatus
      }
    },
    seedTitle(title: string): void {
      lastStatus = detectAgentStatusFromTitle(title)
      restorableExitStatus = null
    },
    restoreLastExit(confirmedStatus?: AgentStatus): AgentStatus | null {
      const restoredStatus = confirmedStatus ?? (lastStatus === null ? restorableExitStatus : null)
      if (restoredStatus !== null) {
        lastStatus = restoredStatus
      }
      restorableExitStatus = null
      return restoredStatus
    },
    reset(): void {
      lastStatus = null
      restorableExitStatus = null
    }
  }
}

/**
 * Normalize high-churn agent titles into stable display labels before storage.
 */
export function normalizeTerminalTitle(title: string): string {
  if (!title) {
    return title
  }

  // Why: a Pi/OMP label is cwd/session text that may contain Gemini's glyphs; its own
  // state marker is explicit, so it outranks glyph sniffing here as it does in detection.
  if (!getPiStateTitleStatus(title) && isGeminiTerminalTitle(title)) {
    const status = detectAgentStatusFromTitle(title)
    if (status === 'permission') {
      return `${GEMINI_PERMISSION} Gemini CLI`
    }
    if (status === 'working') {
      return `${GEMINI_WORKING} Gemini CLI`
    }
    if (status === 'idle') {
      return `${GEMINI_IDLE} Gemini CLI`
    }
  }

  // Why: Pi/OMP animate a braille frame every 80ms, so the frame is the churn — but the rest of
  // the title is the session name and cwd the agent chose. Canonicalize the frame in place
  // (it leads in `⠋ π - session - cwd` and sits medially in `π ⠋ label`) and keep everything
  // else; collapsing to a bare "Pi" discarded both the identity and the label (#16093).
  // Why segments: a multiplexer prefixes the pane title (`zsh | ⠋ π - …`), and an anchored
  // match would skip the canonicalization and let the frame churn through (#8032).
  if (getWrapperTitleSegments(title).some(isPiAgentTitle)) {
    return canonicalizeBrailleSpinnerFrame(title)
  }

  // Why: Grok Build interpolates a rotating status/tool phrase between the
  // spinner and its name, so its working frames change the title many times per
  // turn. Collapse them to one stable label; idle/session titles carry no
  // spinner and pass through, so the meaningful final title still shows (#7863).
  if (isGrokRotatingWorkingTitle(title)) {
    return '\u280b Grok'
  }

  return title
}

/** Why: any braille frame reads as the same animation step, so consecutive frames dedupe. */
function canonicalizeBrailleSpinnerFrame(title: string): string {
  let canonical = ''
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    canonical +=
      codePoint !== undefined && codePoint >= 0x2800 && codePoint <= 0x28ff ? '\u280b' : char
  }
  return canonical
}

/**
 * Whether an idle verdict rests on a positive idle marker the agent emitted, or
 * only on the agent's NAME appearing in the title. A name-only title is emitted
 * just as often mid-turn as between turns, so it is not evidence of settlement
 * on its own (#6011).
 */
export type AgentTitleIdleEvidence = 'explicit' | 'name-only'

type AgentTitleClassification = {
  status: AgentStatus | null
  /** Only set when `status` is `idle`. */
  idleEvidence: AgentTitleIdleEvidence | null
}

const NO_AGENT: AgentTitleClassification = { status: null, idleEvidence: null }
const WORKING: AgentTitleClassification = { status: 'working', idleEvidence: null }
const PERMISSION: AgentTitleClassification = { status: 'permission', idleEvidence: null }
const EXPLICIT_IDLE: AgentTitleClassification = { status: 'idle', idleEvidence: 'explicit' }
const NAME_ONLY_IDLE: AgentTitleClassification = { status: 'idle', idleEvidence: 'name-only' }

/** For sub-detectors that own an explicit state protocol and return a bare status. */
function fromExplicitStatus(status: AgentStatus): AgentTitleClassification {
  if (status === 'idle') {
    return EXPLICIT_IDLE
  }
  return status === 'working' ? WORKING : PERMISSION
}

function computeAgentTitleClassification(title: string): AgentTitleClassification {
  if (!title || isClaudeManagementTitle(title)) {
    return NO_AGENT
  }
  if (title.trim().toLowerCase() === CURSOR_NATIVE_TITLE_LOWER) {
    return NO_AGENT
  }

  if (isOpenCodeNativeTitle(title)) {
    return containsAgentSpinnerGlyph(title) ? WORKING : EXPLICIT_IDLE
  }

  // Why: Pi/OMP's marker is an explicit state protocol, so it wins over the glyph and
  // keyword gates below — its label is free-form cwd/session text that can carry either.
  const piStateStatus = getPiStateTitleStatus(title)
  if (piStateStatus) {
    return fromExplicitStatus(piStateStatus)
  }

  if (title.includes(GEMINI_PERMISSION)) {
    return PERMISSION
  }
  if (title.includes(GEMINI_WORKING) || title.includes(GEMINI_SILENT_WORKING)) {
    return WORKING
  }
  if (title.includes(GEMINI_IDLE)) {
    return EXPLICIT_IDLE
  }

  // Why: resolve synthetic Pi/OMP permission/idle labels before the broader
  // Pi and braille-spinner checks below.
  const piCompatibleSyntheticAgentStatus = getPiCompatibleSyntheticAgentStatus(title)
  if (piCompatibleSyntheticAgentStatus) {
    return fromExplicitStatus(piCompatibleSyntheticAgentStatus)
  }

  if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) {
    return EXPLICIT_IDLE
  }
  // Why: read the state separator before the blanket idle below — `π ! <label>` is a
  // blocked agent, and treating it as idle hides an OMP pane waiting on the user.
  const piCompatibleSeparatorStatus = getPiCompatibleTitleSeparatorStatus(title)
  if (piCompatibleSeparatorStatus) {
    return fromExplicitStatus(piCompatibleSeparatorStatus)
  }
  if (isPiTerminalTitle(title)) {
    return EXPLICIT_IDLE
  }
  if (containsAgentSpinnerGlyph(title)) {
    return WORKING
  }
  const hasDroidAgentName = DROID_AGENT_NAME_RE.test(title)
  const hasHermesAgentName = HERMES_AGENT_NAME_RE.test(title)
  const hasAgyAgentName = AGY_AGENT_NAME_RE.test(title)
  const hasLegacyAgentName = containsLegacyAgentName(title)
  if (!hasLegacyAgentName && !hasDroidAgentName && !hasHermesAgentName && !hasAgyAgentName) {
    return NO_AGENT
  }
  if (containsAny(title, ['action required', 'permission', 'waiting'])) {
    return PERMISSION
  }
  // Why: boundary-aware regexes avoid cwd/path and substring false positives.
  if (STRONG_IDLE_KEYWORDS_RE.test(title)) {
    return EXPLICIT_IDLE
  }
  if (STRONG_WORKING_KEYWORDS_RE.test(title)) {
    return WORKING
  }
  if (title.startsWith('. ')) {
    return WORKING
  }
  if (title.startsWith('* ')) {
    return EXPLICIT_IDLE
  }

  // Why: Droid hook events are authoritative; native name-only titles should
  // not turn a still-sleeping execute tool into completion.
  if (hasDroidAgentName && !hasLegacyAgentName) {
    return NO_AGENT
  }

  // Why still `idle`: the sidebar, `worktree ps` and mobile all need a name-only
  // title to clear a stale spinner (#1437). The verdict keeps its display meaning
  // and carries its weak provenance alongside, so settlement decisions can refuse
  // it without every reader losing the row.
  return NAME_ONLY_IDLE
}

/** Pure in `title` — memoized for the same reason the status projection below is. */
const classifyAgentTitle: (title: string) => AgentTitleClassification = memoizeTitleClassification(
  computeAgentTitleClassification
)

/**
 * The idle provenance behind `detectAgentStatusFromTitle`, or null when the title
 * is not idle. `tui-idle` satisfaction needs `explicit`; `name-only` needs
 * corroboration (see `stored-agent-idle-evidence.ts`).
 */
export function detectAgentTitleIdleEvidence(title: string): AgentTitleIdleEvidence | null {
  return classifyAgentTitle(title).idleEvidence
}

/**
 * Pure in `title`, so it is memoized on the title string: sidebar/tab selectors
 * re-ask for the same unchanged titles on every store write.
 */
export const detectAgentStatusFromTitle: (title: string) => AgentStatus | null = (title: string) =>
  classifyAgentTitle(title).status

/**
 * True when a quarter-circle spinner frame is the only agent evidence a title carries.
 * Any TUI animates those glyphs, so they prove activity, not identity — callers that
 * authorize writes into the pane need independent evidence (STA-4028, regression #13925).
 */
export function isQuarterCircleSpinnerOnlyAgentTitle(title: string | null | undefined): boolean {
  if (!title || !containsQuarterCircleSpinner(title)) {
    return false
  }
  return detectAgentStatusFromTitle(title.replace(QUARTER_CIRCLE_SPINNER_RE, '').trim()) === null
}
