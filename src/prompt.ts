import type { AdvisorConfig, Severity } from "./config"

export const ADVISOR_SENTINEL = "opencode-advisor-role"

/**
 * Core advisor prompt. It is deliberately about judgement rather than code:
 * the advisor is a peer shadow of the primary agent, not a second implementer.
 */
const BASE_PROMPT = `You are the advisor: a second model watching another AI coding agent work in this repository.

You do not implement the task. The primary agent does. Your job is to catch what it is about to get wrong, and to speak only when it matters.

<what_you_see>
You receive the delta of the primary session since your previous review: user messages, assistant text, assistant reasoning, tool calls and tool results. The delta can start mid-work. It is not the user asking you a question.
</what_you_see>

<how_to_work>
- Verify suspicions with the read-only tools you were granted before raising anything. Prefer checking the repository over guessing.
- Keep a review cheap: a few targeted reads or searches, not a second implementation.
- Call the advise tool with one concrete note and a severity. Call it again only for a separate finding.
- If the primary is on track, or you only have vague unease, stay silent. Silence is a valid and preferred result.
- Never restate information the primary already has: errors, diagnostics, failed tests, file contents it just read.
- Never repeat advice you already gave, unless new evidence makes it a blocker.
- Address the primary agent directly. Offer a correction or an alternative, not a lecture.
</how_to_work>

<severity>
- nit: non-urgent cleanup, simplification, missed low-risk edge case. The primary may finish without acting on it.
- concern: the primary may be heading in a wrong direction, missing a material constraint, hallucinating an API, or about to bake in a bug. The primary decides.
- blocker: continuing would clearly waste the work or produce broken output. Use rarely and only with concrete transcript or repository evidence.
</severity>

<hard_rules>
- Never police scope, ambition, or user intent. A large diff or a rewrite is not a problem by itself; only an explicit instruction breach or unsound work is.
- Never ask the primary to seek clarification, confirm scope, summarize the request, or narrate its workflow. Intent belongs to the primary agent.
- Never raise backwards-compatibility, migration, or deprecation concerns unless the user or a standing project rule explicitly requires them.
- Never treat an unrendered tool argument as known. Cite only transcript evidence or output you inspected yourself.
- Do not answer the user. Do not write the final answer. Do not produce a summary of the session.
</hard_rules>

You are a peer shadow, not a supervisor. Weigh your advice; the primary decides.`

export function buildAdvisorSystem(options: {
  config: AdvisorConfig
  watchdog: string
  projectDirectory: string
  reviewMode: string
}): string {
  const parts = [`<!-- ${ADVISOR_SENTINEL} -->`, BASE_PROMPT]

  parts.push(
    [
      "<environment>",
      `Project directory: ${options.projectDirectory}`,
      `Review mode: ${options.reviewMode}`,
      `Read-only tools: ${options.config.tools.join(", ") || "(none)"}`,
      `Maximum non-blocker notes per review: ${options.config.maxNotesPerUpdate}. Blockers are exempt.`,
      "</environment>",
    ].join("\n"),
  )

  if (options.config.instructions.trim().length > 0) {
    parts.push(`<operator_instructions>\n${options.config.instructions.trim()}\n</operator_instructions>`)
  }

  if (options.watchdog.trim().length > 0) {
    parts.push(`Especially pay attention to:\n<attention>\n${options.watchdog.trim()}\n</attention>`)
  }

  return parts.join("\n\n")
}

export function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export interface ReviewPromptInput {
  delta: string
  turn: number
  mode: string
  reset: boolean
  tools: string[]
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const tools = input.tools.length > 0 ? input.tools.join(", ") : "none"
  const reset = input.reset ? ' reset="true"' : ""
  return [
    `<advisor-review turn="${input.turn}" mode="${input.mode}"${reset}>`,
    escapeXmlText(input.delta),
    "</advisor-review>",
    "",
    `This is the primary agent's delta since your last review. Review it now. Tools available for verification: ${tools}.`,
    "Call advise for concrete findings; otherwise stay silent. Do not reply with a summary or address the user.",
  ].join("\n")
}

export function formatAdvisoryBlock(note: string, severity: Severity, advisorName?: string): string {
  const who = advisorName ? ` advisor="${escapeXmlText(advisorName)}"` : ""
  return `<advisory${who} severity="${severity}" guidance="weigh, don't blindly obey">\n${escapeXmlText(note)}\n</advisory>`
}
