export interface TranscriptOptions {
  includeReasoning: boolean
  initialReplay: number
  maxBlockChars?: number
  maxTotalChars?: number
}

export interface TranscriptBatch {
  text: string
  count: number
  ids: string[]
  userCount: number
  reset: boolean
}

type Loose = Record<string, any>

const SKIP_TYPES = new Set([
  "system",
  "agent-switched",
  "model-switched",
  "location-switched",
  "idle",
])

const DEFAULT_BLOCK_LIMIT = 4_000
const DEFAULT_TOTAL_LIMIT = 32_000

export function elide(value: string, limit: number): string {
  if (value.length <= limit) return value
  const omitted = value.length - limit
  const head = value.slice(0, Math.max(0, limit - 200))
  return `${head}\n[... elided ${omitted} chars ...]`
}

function stringify(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toolResult(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const item = part as Loose
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text)
    else if (item.type === "file") parts.push(`[file ${item.uri ?? "?"} (${item.mime ?? "unknown"})]`)
    else parts.push(stringify(part))
  }
  return parts.join("\n")
}

function renderTool(part: Loose, blockLimit: number): string {
  const name = typeof part.name === "string" ? part.name : "tool"
  const state = part.state ?? {}
  const status = typeof state.status === "string" ? state.status : "unknown"
  const lines: string[] = [`### Tool call: ${name} (${status})`]

  if (status === "streaming") {
    if (typeof state.input === "string" && state.input.length > 0) {
      lines.push(`input (partial): ${elide(state.input, blockLimit)}`)
    }
    return lines.join("\n")
  }

  if (state.input !== undefined) {
    lines.push(`input: ${elide(stringify(state.input), blockLimit)}`)
  }
  if (status === "error") {
    const message = state.error?.message ?? "tool failed"
    lines.push(`error: ${elide(String(message), blockLimit)}`)
    const content = toolResult(state.content)
    if (content) lines.push(`output: ${elide(content, blockLimit)}`)
  } else if (status === "completed") {
    const content = toolResult(state.content)
    if (content) lines.push(`output: ${elide(content, blockLimit)}`)
  }
  return lines.join("\n")
}

function renderMessage(message: Loose, options: TranscriptOptions, blockLimit: number): string | undefined {
  const type = typeof message.type === "string" ? message.type : "unknown"
  if (SKIP_TYPES.has(type)) return undefined
  if (message.metadata?.advisorNote === true) return undefined

  if (type === "user") {
    const text = typeof message.text === "string" ? message.text : ""
    return text.trim().length > 0 ? `## User\n${elide(text, blockLimit)}` : undefined
  }

  if (type === "synthetic") {
    const text = typeof message.text === "string" ? message.text : ""
    const description = typeof message.description === "string" ? ` (${message.description})` : ""
    return text.trim().length > 0 ? `## Synthetic${description}\n${elide(text, blockLimit)}` : undefined
  }

  if (type === "assistant") {
    const content = Array.isArray(message.content) ? message.content : []
    const blocks: string[] = []
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue
      const part = raw as Loose
      if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        blocks.push(`### Assistant text\n${elide(part.text, blockLimit)}`)
      } else if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim().length > 0) {
        if (options.includeReasoning) blocks.push(`### Assistant reasoning\n${elide(part.text, blockLimit)}`)
      } else if (part.type === "tool") {
        blocks.push(elide(renderTool(part, blockLimit), blockLimit))
      }
    }
    if (blocks.length === 0) return undefined
    const finish = typeof message.finish === "string" ? ` (${message.finish})` : ""
    return `## Assistant${finish}\n${blocks.join("\n\n")}`
  }

  if (type === "shell") {
    const command = typeof message.command === "string" ? message.command : ""
    const output =
      typeof message.output === "string"
        ? message.output
        : typeof message.output?.output === "string"
          ? message.output.output
          : ""
    const parts = [`## Shell\n$ ${command}`]
    if (output.trim().length > 0) parts.push(elide(output, blockLimit))
    if (typeof message.exit === "number") parts.push(`[exit ${message.exit}]`)
    return parts.join("\n")
  }

  if (type === "compaction") {
    const text =
      typeof message.summary === "string"
        ? message.summary
        : typeof message.text === "string"
          ? message.text
          : ""
    return text.trim().length > 0 ? `## Compaction\n${elide(text, blockLimit)}` : undefined
  }

  return undefined
}

/**
 * Cursor over a session transcript. It never advances on its own: the caller
 * commits after a review succeeds, so a failed advisor turn can retry the same
 * delta instead of silently losing it.
 */
export class TranscriptCursor {
  #lastID: string | undefined
  #seeded = false

  get seeded(): boolean {
    return this.#seeded
  }

  reset(): void {
    this.#lastID = undefined
    this.#seeded = false
  }

  /** Mark the whole current transcript as already seen. */
  seed(messages: Loose[]): void {
    this.#lastID = messages.at(-1)?.id
    this.#seeded = true
  }

  peek(messages: Loose[], options: TranscriptOptions): TranscriptBatch {
    const blockLimit = options.maxBlockChars ?? DEFAULT_BLOCK_LIMIT
    const totalLimit = options.maxTotalChars ?? DEFAULT_TOTAL_LIMIT

    let start = 0
    let reset = false
    if (!this.#seeded) {
      reset = true
      start = Math.max(0, messages.length - options.initialReplay)
    } else if (this.#lastID) {
      const index = messages.findIndex((message) => message.id === this.#lastID)
      if (index === -1) {
        reset = true
        start = Math.max(0, messages.length - options.initialReplay)
      } else {
        start = index + 1
      }
    }

    const slice = messages.slice(start)
    const ids: string[] = []
    const blocks: string[] = []
    let userCount = 0

    for (const message of slice) {
      const id = typeof message.id === "string" ? message.id : undefined
      if (id) ids.push(id)
      if (message.type === "user") userCount++
      const rendered = renderMessage(message, options, blockLimit)
      if (rendered) blocks.push(rendered)
    }

    if (blocks.length === 0) {
      return { text: "", count: 0, ids, userCount, reset }
    }

    let text = blocks.join("\n\n")
    if (text.length > totalLimit) {
      const clipped = text.slice(text.length - totalLimit)
      const cut = clipped.indexOf("\n\n")
      text = `[... earlier delta elided ...]\n\n${cut === -1 ? clipped : clipped.slice(cut + 2)}`
    }

    return { text, count: blocks.length, ids, userCount, reset }
  }

  commit(batch: TranscriptBatch): void {
    if (batch.ids.length > 0) {
      this.#lastID = batch.ids.at(-1)
      this.#seeded = true
    }
  }
}
