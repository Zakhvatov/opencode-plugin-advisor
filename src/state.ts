import type { ModelRef, Severity } from "./config"
import { AdvisorEmissionGuard } from "./guard"
import { TranscriptCursor } from "./transcript"

export interface PendingNote {
  note: string
  severity: Severity
}

export interface PrimaryState {
  id: string
  directory?: string
  advisorID?: string
  advisorModel?: ModelRef
  cursor: TranscriptCursor
  guard: AdvisorEmissionGuard
  busy: boolean
  resumeArmed: boolean
  reviewsSinceUser: number
  eligible: number
  queue: boolean
  running: boolean
  pending: PendingNote[]
  failures: number
  nextAttemptAt: number
  lastReviewAt?: number
  lastError?: string
  lastNoteAt?: number
  skipped?: boolean
}

export interface AdvisorRuntimeLike {
  admit(advisorSessionID: string, note: string, severity?: Severity): { accepted: boolean; reason?: string }
}

export interface SharedRegistry {
  claims: Map<string, string>
  states: Map<string, PrimaryState>
  advisors: Map<string, { state: PrimaryState; runtime: AdvisorRuntimeLike }>
  disabled: Set<string>
}

const KEY = Symbol.for("opencode-plugin-advisor.shared.v1")

export function shared(): SharedRegistry {
  const holder = globalThis as unknown as Record<symbol, SharedRegistry | undefined>
  let registry = holder[KEY]
  if (!registry) {
    registry = {
      claims: new Map(),
      states: new Map(),
      advisors: new Map(),
      disabled: new Set(),
    }
    holder[KEY] = registry
  }
  return registry
}

export function createState(id: string, budgetPerUpdate: number): PrimaryState {
  return {
    id,
    cursor: new TranscriptCursor(),
    guard: new AdvisorEmissionGuard({ budgetPerUpdate }),
    busy: false,
    resumeArmed: true,
    reviewsSinceUser: 0,
    eligible: 0,
    queue: false,
    running: false,
    pending: [],
    failures: 0,
    nextAttemptAt: 0,
  }
}

export function admitAdvisorNote(
  advisorSessionID: string,
  note: string,
  severity?: Severity,
): { accepted: boolean; reason?: string; displaced?: boolean } {
  const entry = shared().advisors.get(advisorSessionID)
  if (!entry) return { accepted: false, reason: "this session is not a watched advisor session" }
  return entry.runtime.admit(advisorSessionID, note, severity) as {
    accepted: boolean
    reason?: string
    displaced?: boolean
  }
}
