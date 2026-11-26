import { mkdirSync, appendFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  highestSeverity,
  parseModelSelector,
  severityRank,
  type AdvisorConfig,
  type ModelRef,
  type Severity,
} from "./config"
import { formatAdvisoryBlock, buildAdvisorSystem, buildReviewPrompt } from "./prompt"
import {
  admitAdvisorNote,
  createState,
  shared,
  type PendingNote,
  type PrimaryState,
} from "./state"
import { TranscriptCursor } from "./transcript"
import { loadWatchdog } from "./watchdog"
import { normalizeAdvisorNote } from "./guard"

const EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.step.ended",
  "session.deleted",
] as const

function pid(): string {
  return Math.random().toString(36).slice(2, 10)
}

function unwrap<T>(value: any): T | undefined {
  if (value === undefined || value === null) return undefined
  return (value.data ?? value) as T
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export interface RuntimeHooks {
  /** Called when a note is accepted, for TUI/debug surfaces. */
  onNote?: (note: string, severity: Severity) => void
}

/**
 * One plugin instance. Several instances may exist for the same server (for
 * example a global and a project config). The shared registry makes exactly one
 * instance own a primary session, while any instance can serve the advise tool.
 */
export class AdvisorRuntime {
  readonly id = pid()
  readonly config: AdvisorConfig
  readonly warnings: string[]
  #ctx: any
  #controller: AbortController | undefined
  #disposed = false
  #debugFile: string | undefined
  #hooks: RuntimeHooks

  constructor(ctx: any, config: AdvisorConfig, warnings: string[], hooks: RuntimeHooks = {}) {
    this.#ctx = ctx
    this.config = config
    this.warnings = warnings
    this.#hooks = hooks
    this.#debugFile = process.env.ADVISOR_DEBUG_FILE
  }

  get ctx(): any {
    return this.#ctx
  }

  start(): void {
    if (this.#disposed) return
    const controller = new AbortController()
    this.#controller = controller
    void (async () => {
      try {
        for await (const event of this.#ctx.event.subscribe({
          types: [...EVENT_TYPES],
          signal: controller.signal,
        })) {
          if (this.#disposed) break
          void this.handleEvent(event).catch((error) => this.debug(`event error: ${messageOf(error)}`))
        }
      } catch (error) {
        if (!controller.signal.aborted) this.debug(`event stream stopped: ${messageOf(error)}`)
      }
    })()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#controller?.abort()
    const registry = shared()
    for (const [primaryID, owner] of registry.claims) {
      if (owner === this.id) registry.claims.delete(primaryID)
    }
    for (const [advisorID, entry] of registry.advisors) {
      if (entry.runtime === this) registry.advisors.delete(advisorID)
    }
    for (const [sessionID, state] of registry.states) {
      if (!registry.claims.has(sessionID)) registry.states.delete(sessionID)
    }
  }

  isAdvisorSession(sessionID: string): boolean {
    return shared().advisors.has(sessionID)
  }

  /**
   * System text for an advisor request. The sentinel makes the append
   * idempotent when two plugin instances both run the context hook.
   */
  systemFor(advisorSessionID: string): string | undefined {
    const entry = shared().advisors.get(advisorSessionID)
    if (!entry) return undefined
    const directory = entry.state.directory ?? this.#ctx.location?.directory ?? process.cwd()
    const projectRoot = this.#ctx.location?.project?.canonical ?? directory
    const watchdog = loadWatchdog(directory, projectRoot, this.config.watchdog)
    return buildAdvisorSystem({
      config: this.config,
      watchdog,
      projectDirectory: directory,
      reviewMode: this.config.reviewMode,
    })
  }

  /** Called from the advise tool. */
  admit(advisorSessionID: string, note: string, severity?: Severity): { accepted: boolean; reason?: string } {
    const entry = shared().advisors.get(advisorSessionID)
    if (!entry) return { accepted: false, reason: "this session is not a watched advisor session" }

    const state = entry.state
    const decision = state.guard.admit(note, severity)
    if (!decision.accepted) {
      return { accepted: false, reason: decision.reason }
    }

    if (decision.displacedKey) {
      state.pending = state.pending.filter((pending) => normalizeAdvisorNote(pending.note) !== decision.displacedKey)
    }
    const resolved: PendingNote = { note: note.trim(), severity: severity ?? "nit" }
    state.pending.push(resolved)
    this.#hooks.onNote?.(resolved.note, resolved.severity)
    this.debug(`accepted ${resolved.severity} note: ${resolved.note.slice(0, 120)}`)
    return { accepted: true }
  }

  async toggle(sessionID: string, enabled: boolean): Promise<string> {
    const registry = shared()
    if (!enabled) {
      registry.disabled.add(sessionID)
      const state = registry.states.get(sessionID)
      if (state?.advisorID) {
        await this.#ctx.session.interrupt({ sessionID: state.advisorID }).catch(() => undefined)
      }
      return "Advisor disabled for this session."
    }

    registry.disabled.delete(sessionID)
    const state = this.#state(sessionID)
    state.skipped = undefined
    registry.claims.set(sessionID, this.id)
    this.schedule(state, "agent-end")
    return "Advisor enabled for this session."
  }

  status(sessionID: string): string {
    const registry = shared()
    const state = registry.states.get(sessionID)
    const enabled = !registry.disabled.has(sessionID)
    const lines = [
      `Advisor: ${enabled ? "on" : "off"}`,
      `Model: ${this.config.model ?? "primary session model"}`,
      `Cadence: ${this.config.reviewMode}, every ${this.config.reviewInterval} update(s)`,
      `Tools: ${this.config.tools.join(", ") || "(none)"}`,
      `Continue severity: ${this.config.continueSeverity}`,
    ]
    if (state) {
      lines.push(`Reviews this run: ${state.reviewsSinceUser}`)
      if (state.lastReviewAt) lines.push(`Last review: ${new Date(state.lastReviewAt).toISOString()}`)
      if (state.advisorID) lines.push(`Advisor session: ${state.advisorID} (archived)`)
      if (state.lastError) lines.push(`Last error: ${state.lastError}`)
      if (state.pending.length > 0) lines.push(`Pending notes: ${state.pending.length}`)
    } else {
      lines.push("No review has run for this session yet.")
    }
    if (this.warnings.length > 0) lines.push(`Config warnings: ${this.warnings.join("; ")}`)
    return lines.join("\n")
  }

  private async handleEvent(event: any): Promise<void> {
    const sessionID = event?.data?.sessionID
    if (!sessionID) return

    if (this.isAdvisorSession(sessionID)) {
      if (event.type === "session.deleted") {
        const entry = shared().advisors.get(sessionID)
        if (entry) {
          entry.state.advisorID = undefined
          shared().advisors.delete(sessionID)
        }
      }
      return
    }

    const registry = shared()
    if (registry.disabled.has(sessionID)) return

    if (event.type === "session.deleted") {
      await this.cleanup(sessionID)
      return
    }

    if (!(await this.watches(sessionID))) return

    const state = this.#state(sessionID)
    switch (event.type) {
      case "session.execution.started":
        state.busy = true
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
        state.busy = false
        return
      case "session.execution.interrupted":
        state.busy = false
        // A deliberate stop must not be auto-resumed by an advisor continuation.
        state.resumeArmed = false
        return
      case "session.idle":
        state.busy = false
        if (this.config.reviewMode === "agent-end") this.schedule(state, "agent-end")
        return
      case "session.step.ended": {
        if (!this.claim(sessionID)) return
        const finish = event.data?.finish
        if (this.config.reviewMode === "turn") this.schedule(state, "turn")
        else if (finish !== "tool-calls") this.schedule(state, "agent-end")
        return
      }
      default:
        return
    }
  }

  private async watches(sessionID: string): Promise<boolean> {
    if (!this.claim(sessionID)) return false
    const state = this.#state(sessionID)
    if (state.skipped !== undefined) return !state.skipped
    if (!this.config.enabled) {
      state.skipped = true
      return false
    }

    try {
      const info = unwrap<any>(await this.#ctx.session.get({ sessionID }))
      if (!info) {
        state.skipped = true
        return false
      }
      state.directory = info.location?.directory ?? state.directory
      const agent = info.agent
      if (agent === "compaction" || agent === "title" || agent === "summary") {
        state.skipped = true
        return false
      }
      if (this.config.scope === "main" && info.parentID) {
        state.skipped = true
        return false
      }
      return true
    } catch (error) {
      // A transient lookup failure must not permanently disable watching.
      this.debug(`cannot inspect session ${sessionID}: ${messageOf(error)}`)
      return false
    }
  }

  private claim(sessionID: string): boolean {
    const registry = shared()
    const owner = registry.claims.get(sessionID)
    if (owner && owner !== this.id) return false
    registry.claims.set(sessionID, this.id)
    return true
  }

  #state(sessionID: string): PrimaryState {
    const registry = shared()
    let state = registry.states.get(sessionID)
    if (!state) {
      state = createState(sessionID, this.config.maxNotesPerUpdate)
      registry.states.set(sessionID, state)
    }
    return state
  }

  private schedule(state: PrimaryState, mode: "turn" | "agent-end"): void {
    if (this.#disposed) return
    if (shared().disabled.has(state.id)) return
    if (shared().claims.get(state.id) !== this.id) return
    state.queue = true
    if (state.running) return
    state.running = true
    void (async () => {
      try {
        let steps = 0
        while (state.queue && !this.#disposed) {
          state.queue = false
          if (steps++ > 200) break
          await this.review(state, mode)
        }
      } catch (error) {
        this.debug(`review loop failed: ${messageOf(error)}`)
        state.lastError = messageOf(error)
      } finally {
        state.running = false
      }
    })()
  }

  private async review(state: PrimaryState, mode: "turn" | "agent-end"): Promise<void> {
    if (this.#disposed) return
    const messages = await this.#ctx.session.context({ sessionID: state.id })
    const wasSeeded = state.cursor.seeded
    const batch = state.cursor.peek(Array.isArray(messages) ? messages : [], {
      includeReasoning: this.config.includeReasoning,
      initialReplay: this.config.initialReplay,
    })

    if (batch.userCount > 0) {
      state.resumeArmed = true
      state.reviewsSinceUser = 0
      state.failures = 0
      state.nextAttemptAt = 0
    }

    if (batch.count === 0) {
      state.cursor.commit(batch)
      return
    }
    if (Date.now() < state.nextAttemptAt) return

    state.eligible++
    if (state.eligible % this.config.reviewInterval !== 0) {
      this.debug(`skip review ${state.eligible} (interval ${this.config.reviewInterval})`)
      return
    }
    if (state.reviewsSinceUser >= this.config.maxReviewsPerRun) {
      state.cursor.commit(batch)
      this.debug(`review cap reached for ${state.id}`)
      return
    }
    if (
      this.config.minReviewGapMs > 0 &&
      state.lastReviewAt &&
      Date.now() - state.lastReviewAt < this.config.minReviewGapMs
    ) {
      return
    }

    if (batch.reset && wasSeeded) state.guard.reset()

    const advisorID = await this.ensureAdvisor(state)
    if (!advisorID) return

    const turn = state.reviewsSinceUser + 1
    const text = buildReviewPrompt({
      delta: batch.text,
      turn,
      mode,
      reset: batch.reset,
      tools: this.config.tools,
    })

    state.guard.beginUpdate(this.config.maxNotesPerUpdate)
    state.pending = []
    state.lastReviewAt = Date.now()
    state.lastError = undefined

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.debug(`review timed out after ${this.config.reviewTimeoutMs}ms`)
      void this.#ctx.session.interrupt({ sessionID: advisorID }).catch(() => undefined)
    }, this.config.reviewTimeoutMs)

    try {
      await this.#ctx.session.prompt({
        sessionID: advisorID,
        text,
        metadata: { advisorReview: true, primaryID: state.id, turn },
      })
      await this.#ctx.session.wait({ sessionID: advisorID })

      if (timedOut) {
        state.cursor.commit(batch)
        state.failures++
        state.lastError = "review timed out"
        return
      }

      state.cursor.commit(batch)
      state.reviewsSinceUser++
      state.failures = 0

      const notes = state.pending
      state.pending = []
      if (notes.length > 0 && !shared().disabled.has(state.id)) await this.deliver(state, notes)
    } catch (error) {
      state.failures++
      state.lastError = messageOf(error)
      const delay = Math.min(60_000, 2 ** Math.min(state.failures, 6) * 5_000)
      state.nextAttemptAt = Date.now() + delay
      if (timedOut) state.cursor.commit(batch)
      this.debug(`review failed (${state.failures}), retry in ${delay}ms: ${state.lastError}`)
    } finally {
      clearTimeout(timer)
      await this.archive(advisorID)
    }
  }

  private async deliver(state: PrimaryState, notes: PendingNote[]): Promise<void> {
    if (this.#disposed) return
    const ordered = [...notes].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    const max = highestSeverity(ordered)
    const text = ordered.map((note) => formatAdvisoryBlock(note.note, note.severity)).join("\n")

    const mayResume =
      state.resumeArmed &&
      !state.busy &&
      severityRank(max) >= severityRank(this.config.continueSeverity)

    await this.#ctx.session.synthetic({
      sessionID: state.id,
      text,
      description: `Advisor note (${max})`,
      metadata: {
        advisorNote: true,
        advisorSessionID: state.advisorID,
        severity: max,
      },
      delivery: "steer",
      resume: mayResume,
    })

    state.lastNoteAt = Date.now()
    if (mayResume) state.resumeArmed = false
    this.debug(
      `delivered ${ordered.length} note(s), severity=${max}, resume=${mayResume}, idle=${!state.busy}`,
    )
  }

  private async ensureAdvisor(state: PrimaryState): Promise<string | undefined> {
    const registry = shared()
    if (state.advisorID) {
      const alive = unwrap<any>(await this.#ctx.session.get({ sessionID: state.advisorID }).catch(() => undefined))
      if (alive) {
        registry.advisors.set(state.advisorID, { state, runtime: this })
        return state.advisorID
      }
      registry.advisors.delete(state.advisorID)
      state.advisorID = undefined
    }

    let primary: any
    try {
      primary = unwrap<any>(await this.#ctx.session.get({ sessionID: state.id }))
    } catch {
      primary = undefined
    }
    state.directory = primary?.location?.directory ?? state.directory ?? this.#ctx.location?.directory

    const model = await this.resolveModel(primary)
    if (!model) {
      state.lastError =
        "no advisor model: set the plugin `model` option or run the primary session with a model first"
      this.debug(state.lastError)
      return undefined
    }

    try {
      const created = unwrap<any>(
        await this.#ctx.session.create({
          title: `[advisor] ${primary?.title ?? state.id}`,
          model,
          metadata: {
            advisor: true,
            primaryID: state.id,
            plugin: "opencode-plugin-advisor",
          },
        }),
      )
      const advisorID = created?.id
      if (!advisorID) throw new Error("session.create returned no id")
      state.advisorID = advisorID
      state.advisorModel = model
      registry.advisors.set(advisorID, { state, runtime: this })
      await this.archive(advisorID)
      this.debug(`created advisor session ${advisorID} using ${model.providerID}/${model.id}`)
      return advisorID
    } catch (error) {
      state.lastError = `cannot create advisor session: ${messageOf(error)}`
      this.debug(state.lastError)
      return undefined
    }
  }

  private async resolveModel(primary: any): Promise<ModelRef | undefined> {
    const configured = parseModelSelector(this.config.model)
    if (configured) return configured

    const model = primary?.model
    if (model?.providerID && model?.id) {
      return { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) }
    }

    try {
      const fallback = await this.#ctx.model.default()
      const info = fallback?.data ?? fallback
      if (info?.providerID && (info.id || info.modelID)) {
        return {
          providerID: info.providerID,
          id: info.id ?? info.modelID,
          ...(info.variant ? { variant: info.variant } : {}),
        }
      }
    } catch {
      // fall through
    }
    return undefined
  }

  private async archive(sessionID: string): Promise<void> {
    await this.#ctx.session.update({ sessionID, archived: true }).catch(() => undefined)
  }

  private async cleanup(sessionID: string): Promise<void> {
    const registry = shared()
    if (registry.claims.get(sessionID) !== this.id) return
    const state = registry.states.get(sessionID)
    registry.claims.delete(sessionID)
    registry.states.delete(sessionID)
    if (state?.advisorID) {
      registry.advisors.delete(state.advisorID)
      await this.#ctx.session.remove({ sessionID: state.advisorID }).catch(() => undefined)
    }
  }

  private debug(message: string): void {
    const line = `${new Date().toISOString()} [opencode-advisor ${this.id}] ${message}`
    if (this.config.debug) console.warn(line)
    if (this.#debugFile) {
      try {
        mkdirSync(dirname(this.#debugFile), { recursive: true })
        appendFileSync(this.#debugFile, `${line}\n`)
      } catch {
        // diagnostics must never break a review
      }
    }
  }
}

export { admitAdvisorNote, TranscriptCursor }
