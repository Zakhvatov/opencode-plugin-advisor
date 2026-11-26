import { severityRank, type Severity } from "./config"

export type SuppressionReason = "empty" | "noise" | "duplicate" | "rate-limit"

export interface Admission {
  accepted: boolean
  reason?: SuppressionReason
  /** Normalized key of a pending note from the same update that this note displaced. */
  displacedKey?: string
}

export const DEFAULT_HISTORY_CAPACITY = 4096
export const MAX_BUDGET_PER_UPDATE = 32
export const DEFAULT_BUDGET_PER_UPDATE = 4

/**
 * Case-insensitive, punctuation-folded key for a note. `"Stop."`, `"*Stop*"` and
 * `"  stop  "` all normalize to `stop`.
 */
export function normalizeAdvisorNote(note: string): string {
  return note
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/**
 * Short, content-free phrases that models emit when they have nothing to say.
 * Silence is the correct expression for "no issue"; a genuine blocker always
 * carries a concrete reason, so it will not match this list.
 */
const NOISE: Record<string, true> = {
  stop: true,
  "stop here": true,
  "stop now": true,
  halt: true,
  abort: true,
  done: true,
  "task done": true,
  "task complete": true,
  complete: true,
  finished: true,
  ok: true,
  okay: true,
  "ok done": true,
  "no issue": true,
  "no issues": true,
  "no issue continue": true,
  "no concerns": true,
  "no concern": true,
  "nothing to add": true,
  "nothing to flag": true,
  "nothing to report": true,
  "no notes": true,
  "no further input": true,
  "no further input needed": true,
  "no further input required": true,
  "no further watcher input": true,
  "no further watcher input needed": true,
  "no further advice": true,
  "no further advice needed": true,
  lgtm: true,
  "looks good": true,
  "all good": true,
  "agent is on track": true,
  "agent on track": true,
  "on track": true,
  continue: true,
  "carry on": true,
}

interface Slot {
  key: string
  rank: number
}

/**
 * Admission gate for advisor notes. The prompt asks the model for quality, but
 * this class makes the rules load-bearing: no empty notes, no content-free
 * noise, no duplicates at equal or lower severity, and a per-review budget for
 * non-blockers. Blockers bypass the budget, because a blocker must interrupt.
 */
export class AdvisorEmissionGuard {
  readonly #capacity: number
  readonly #defaultBudget: number
  readonly #seen = new Map<string, number>()
  readonly #seenOrder: string[] = []
  #slots: Slot[] = []
  #budget: number

  constructor(options: { capacity?: number; budgetPerUpdate?: number } = {}) {
    this.#capacity = options.capacity ?? DEFAULT_HISTORY_CAPACITY
    const budget = options.budgetPerUpdate
    this.#defaultBudget =
      typeof budget === "number" && Number.isFinite(budget)
        ? Math.min(MAX_BUDGET_PER_UPDATE, Math.max(1, Math.trunc(budget)))
        : DEFAULT_BUDGET_PER_UPDATE
    this.#budget = this.#defaultBudget
  }

  reset(): void {
    this.#seen.clear()
    this.#seenOrder.length = 0
    this.#slots = []
    this.#budget = this.#defaultBudget
  }

  /** Start a new advisor review. Clears the per-update budget. */
  beginUpdate(budgetPerUpdate?: number): void {
    if (budgetPerUpdate !== undefined && Number.isFinite(budgetPerUpdate)) {
      this.#budget = Math.min(MAX_BUDGET_PER_UPDATE, Math.max(1, Math.trunc(budgetPerUpdate)))
    } else {
      this.#budget = this.#defaultBudget
    }
    this.#slots = []
  }

  admit(note: string, severity?: Severity): Admission {
    const normalized = normalizeAdvisorNote(note)
    if (normalized.length === 0) return { accepted: false, reason: "empty" }
    if (NOISE[normalized]) return { accepted: false, reason: "noise" }

    const rank = severityRank(severity)
    const previous = this.#seen.get(normalized)
    if (previous !== undefined && previous >= rank) {
      return { accepted: false, reason: "duplicate" }
    }

    if (severity !== "blocker" && this.#slots.length >= this.#budget) {
      let lowest = 0
      for (let i = 1; i < this.#slots.length; i++) {
        const current = this.#slots[i]!
        const best = this.#slots[lowest]!
        if (current.rank < best.rank) lowest = i
      }
      const victim = this.#slots[lowest]!
      if (rank <= victim.rank) return { accepted: false, reason: "rate-limit" }
      this.#slots.splice(lowest, 1)
      this.#record(normalized, rank)
      this.#slots.push({ key: normalized, rank })
      return { accepted: true, displacedKey: victim.key }
    }

    this.#record(normalized, rank)
    if (severity !== "blocker") this.#slots.push({ key: normalized, rank })
    return { accepted: true }
  }

  #record(key: string, rank: number): void {
    if (!this.#seen.has(key)) {
      this.#seenOrder.push(key)
      if (this.#seenOrder.length > this.#capacity) {
        const evicted = this.#seenOrder.shift()
        if (evicted !== undefined) this.#seen.delete(evicted)
      }
    }
    this.#seen.set(key, rank)
  }
}
