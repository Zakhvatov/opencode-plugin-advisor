export type Severity = "nit" | "concern" | "blocker"
export type ReviewMode = "turn" | "agent-end"
export type AdvisorScope = "main" | "all"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface AdvisorConfig {
  enabled: boolean
  /** Provider/model selector, e.g. `anthropic/claude-sonnet-4-5#high`. Falls back to the primary session model. */
  model?: string
  reviewMode: ReviewMode
  /** Review every Nth eligible update. Skipped updates are folded into the next review. */
  reviewInterval: number
  /** Maximum non-blocker notes accepted per advisor review. Blockers are exempt. */
  maxNotesPerUpdate: number
  /** Lowest severity that may wake an idle primary session. */
  continueSeverity: Severity
  /** Read-only tool names granted to the advisor. */
  tools: string[]
  /** Extra advisor-only guidance, appended after WATCHDOG.md. */
  instructions: string
  /** Minimum wall-clock gap between two advisor reviews of the same session. */
  minReviewGapMs: number
  /** Safety cap on advisor reviews per primary run (reset by a new user message). */
  maxReviewsPerRun: number
  /** Upper bound for one advisor turn before it is interrupted. */
  reviewTimeoutMs: number
  /** How many messages a fresh cursor replays after a start or a transcript rewrite. */
  initialReplay: number
  /** Include the primary model's reasoning blocks in the reviewed delta. */
  includeReasoning: boolean
  /** Load WATCHDOG.md files into the advisor system prompt. */
  watchdog: boolean
  /** Main sessions only, or subagent sessions too. */
  scope: AdvisorScope
  /** Write advisor diagnostics to the OpenCode log. */
  debug: boolean
}

const SEVERITIES: Severity[] = ["nit", "concern", "blocker"]
const REVIEW_MODES: ReviewMode[] = ["turn", "agent-end"]
const SCOPES: AdvisorScope[] = ["main", "all"]

export const DEFAULT_CONFIG: AdvisorConfig = {
  enabled: true,
  reviewMode: "turn",
  reviewInterval: 1,
  maxNotesPerUpdate: 4,
  continueSeverity: "concern",
  tools: ["read", "grep", "glob"],
  instructions: "",
  minReviewGapMs: 0,
  maxReviewsPerRun: 30,
  reviewTimeoutMs: 120_000,
  initialReplay: 20,
  includeReasoning: true,
  watchdog: true,
  scope: "main",
  debug: false,
}

export interface ResolvedConfig {
  config: AdvisorConfig
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.trunc(value)
}

function oneOf<T extends string>(value: unknown, allowed: T[]): T | undefined {
  return typeof value === "string" && (allowed as string[]).includes(value) ? (value as T) : undefined
}

function asToolList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tools = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  return [...new Set(tools.map((tool) => tool.trim()))]
}

/**
 * Resolve plugin options into a complete config. Invalid values fall back to
 * defaults and produce a warning instead of preventing the plugin from loading.
 */
export function resolveConfig(options: unknown): ResolvedConfig {
  const warnings: string[] = []
  const input = isRecord(options) ? options : {}
  const config: AdvisorConfig = { ...DEFAULT_CONFIG, tools: [...DEFAULT_CONFIG.tools] }

  const enabled = asBoolean(input.enabled)
  if (enabled !== undefined) config.enabled = enabled

  const model = asString(input.model)
  if (model !== undefined) {
    const trimmed = model.trim()
    if (trimmed.length > 0) config.model = trimmed
  }

  const reviewMode = oneOf(input.reviewMode ?? input.mode, REVIEW_MODES)
  if (reviewMode) config.reviewMode = reviewMode
  else if (input.reviewMode !== undefined || input.mode !== undefined) {
    warnings.push(`reviewMode must be one of ${REVIEW_MODES.join(", ")}; using ${config.reviewMode}`)
  }

  const reviewInterval = asInt(input.reviewInterval)
  if (reviewInterval !== undefined && reviewInterval > 0) config.reviewInterval = reviewInterval
  else if (input.reviewInterval !== undefined) warnings.push("reviewInterval must be a positive integer; ignoring it")

  const maxNotes = asInt(input.maxNotesPerUpdate ?? input.maxNotes)
  if (maxNotes !== undefined && maxNotes >= 1 && maxNotes <= 32) config.maxNotesPerUpdate = maxNotes
  else if (input.maxNotesPerUpdate !== undefined || input.maxNotes !== undefined) {
    warnings.push("maxNotesPerUpdate must be between 1 and 32; using 4")
  }

  const continueSeverity = oneOf(input.continueSeverity, SEVERITIES)
  if (continueSeverity) config.continueSeverity = continueSeverity
  else if (input.continueSeverity !== undefined) {
    warnings.push(`continueSeverity must be one of ${SEVERITIES.join(", ")}; using concern`)
  }

  const tools = asToolList(input.tools)
  if (tools) config.tools = tools
  else if (input.tools !== undefined) warnings.push("tools must be an array of tool names; using read, grep, glob")

  const instructions = asString(input.instructions)
  if (instructions) config.instructions = instructions

  const gap = asInt(input.minReviewGapMs ?? input.minGapMs)
  if (gap !== undefined && gap >= 0) config.minReviewGapMs = gap
  else if (input.minReviewGapMs !== undefined || input.minGapMs !== undefined) {
    warnings.push("minReviewGapMs must be a non-negative integer; ignoring it")
  }

  const maxReviews = asInt(input.maxReviewsPerRun)
  if (maxReviews !== undefined && maxReviews > 0) config.maxReviewsPerRun = maxReviews
  else if (input.maxReviewsPerRun !== undefined) warnings.push("maxReviewsPerRun must be positive; using 30")

  const timeout = asInt(input.reviewTimeoutMs)
  if (timeout !== undefined && timeout >= 1000) config.reviewTimeoutMs = timeout
  else if (input.reviewTimeoutMs !== undefined) warnings.push("reviewTimeoutMs must be at least 1000; using 120000")

  const replay = asInt(input.initialReplay)
  if (replay !== undefined && replay >= 1 && replay <= 200) config.initialReplay = replay
  else if (input.initialReplay !== undefined) warnings.push("initialReplay must be between 1 and 200; using 20")

  const includeReasoning = asBoolean(input.includeReasoning)
  if (includeReasoning !== undefined) config.includeReasoning = includeReasoning

  const watchdog = asBoolean(input.watchdog)
  if (watchdog !== undefined) config.watchdog = watchdog

  const scope = oneOf(input.scope, SCOPES)
  if (scope) config.scope = scope
  else if (input.scope !== undefined) warnings.push(`scope must be one of ${SCOPES.join(", ")}; using main`)

  const debug = asBoolean(input.debug)
  if (debug !== undefined) config.debug = debug

  return { config, warnings }
}

/**
 * Parse `provider/model` with an optional `#variant` suffix.
 *
 * The first slash separates the provider; model ids may contain slashes.
 */
export function parseModelSelector(selector: string | undefined): ModelRef | undefined {
  if (!selector) return undefined
  const trimmed = selector.trim()
  if (trimmed.length === 0) return undefined

  const hash = trimmed.lastIndexOf("#")
  const reference = hash > 0 ? trimmed.slice(0, hash) : trimmed
  const variant = hash > 0 ? trimmed.slice(hash + 1) : undefined
  const slash = reference.indexOf("/")
  if (slash <= 0 || slash === reference.length - 1) return undefined

  const model: ModelRef = {
    providerID: reference.slice(0, slash),
    id: reference.slice(slash + 1),
  }
  if (variant && variant.length > 0) model.variant = variant
  return model
}

export function severityRank(severity: Severity | undefined): number {
  if (severity === "blocker") return 3
  if (severity === "concern") return 2
  return 1
}

export function highestSeverity(notes: { severity: Severity }[]): Severity {
  let best: Severity = "nit"
  for (const note of notes) {
    if (severityRank(note.severity) > severityRank(best)) best = note.severity
  }
  return best
}
