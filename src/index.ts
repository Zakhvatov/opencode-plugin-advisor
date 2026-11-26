import { Plugin } from "@opencode/plugin"
import { resolveConfig } from "./config"
import { AdvisorRuntime } from "./runtime"
import { admitAdvisorNote } from "./state"
import { ADVISOR_SENTINEL } from "./prompt"
import type { Severity } from "./config"

const SEVERITIES: Severity[] = ["nit", "concern", "blocker"]

const ADVISE_DESCRIPTION = `Send one concrete advisory note to the primary agent you are watching.

Only available inside an advisor session. The note is guidance the primary may weigh, not an order. Use \`blocker\` only when continuing would clearly waste work or produce broken output. Never restate information the primary already has, and never repeat a note you already sent.`

const SEVERITY_DESCRIPTION = `How strongly the primary should weigh this:
- nit: non-urgent cleanup or low-risk edge case
- concern: likely wrong direction or material risk
- blocker: continuing would clearly break the work`

export default Plugin.define({
  id: "opencode-plugin-advisor",

  async setup(ctx: any) {
    const { config, warnings } = resolveConfig(ctx.options)
    if (warnings.length > 0) {
      console.warn(`[opencode-advisor] config: ${warnings.join("; ")}`)
    }

    const runtime = new AdvisorRuntime(ctx, config, warnings)

    try {
      await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "advise",
        description: ADVISE_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            note: {
              type: "string",
              description: "One concrete, terse, actionable piece of advice for the watched agent.",
            },
            severity: {
              type: "string",
              enum: SEVERITIES,
              description: SEVERITY_DESCRIPTION,
            },
          },
          required: ["note"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input: any, context: any) => {
          const decision = admitAdvisorNote(context.sessionID, String(input.note ?? ""), input.severity)
          if (decision.accepted) {
            return {
              content:
                "Advisory accepted. It will be delivered to the primary agent at its next boundary; acceptance does not mean the primary will act on it.",
            }
          }
          const reason = decision.reason ?? "rejected"
          if (reason === "duplicate") {
            return { content: "Not recorded (duplicate): this note, or a stronger version of it, was already advised." }
          }
          if (reason === "noise") {
            return { content: "Not recorded (noise): content-free phrases are suppressed. Stay silent when there is nothing concrete." }
          }
          if (reason === "rate-limit") {
            return {
              content:
                "Not recorded (rate-limit): the per-review non-blocker budget is full. A blocker would still be accepted.",
            }
          }
          return { content: `Not recorded (${reason}).` }
        },
      })
      })
    } catch (error) {
      console.warn(`[opencode-advisor] could not register the advise tool: ${String(error)}`)
    }

    try {
      await ctx.command.transform((editor: any) => {
      editor.add({
        name: "advisor",
        description: "Show or change the advisor state for this session",
        execute: async ({ sessionID, prompt }: any) => {
          const arg = String(prompt?.text ?? "")
            .trim()
            .split(/\s+/)[0]
            ?.toLowerCase()
          let text: string
          if (arg === "on") text = await runtime.toggle(sessionID, true)
          else if (arg === "off") text = await runtime.toggle(sessionID, false)
          else text = `${runtime.status(sessionID)}\n\nUsage: /advisor [status|on|off]`

          await ctx.session.synthetic({
            sessionID,
            text,
            description: "Advisor",
            metadata: { advisorNote: true, advisorControl: true },
            resume: false,
          })
        },
      })
      })
    } catch (error) {
      console.warn(`[opencode-advisor] could not register the /advisor command: ${String(error)}`)
    }

    await ctx.session.hook("context", (event: any) => {
      const tools = event.tools ?? {}
      if (runtime.isAdvisorSession(event.sessionID)) {
        const system = runtime.systemFor(event.sessionID)
        const present = Array.isArray(event.system)
          ? event.system.some(
              (part: any) =>
                typeof part?.text === "string" && part.text.includes(ADVISOR_SENTINEL),
            )
          : false
        if (system && !present && Array.isArray(event.system)) {
          event.system.push({ type: "text", text: system })
        }

        const keep = new Set([...config.tools, "advise"])
        for (const name of Object.keys(tools)) {
          if (!keep.has(name)) delete tools[name]
        }
        return
      }

      // The primary agent and every other session must not see the advise tool.
      if ("advise" in tools) delete tools.advise
    })

    runtime.start()
    return () => runtime.dispose()
  },
})
