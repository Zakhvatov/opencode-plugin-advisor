import { describe, expect, test } from "bun:test"
import { parseModelSelector, resolveConfig } from "../src/config"
import { AdvisorEmissionGuard, normalizeAdvisorNote } from "../src/guard"
import { TranscriptCursor } from "../src/transcript"

describe("config", () => {
  test("defaults are usable without options", () => {
    const { config } = resolveConfig(undefined)
    expect(config.enabled).toBe(true)
    expect(config.reviewMode).toBe("turn")
    expect(config.reviewInterval).toBe(1)
    expect(config.maxNotesPerUpdate).toBe(4)
    expect(config.continueSeverity).toBe("concern")
    expect(config.tools).toEqual(["read", "grep", "glob"])
  })

  test("invalid values fall back with warnings", () => {
    const { config, warnings } = resolveConfig({
      reviewMode: "everything",
      reviewInterval: 0,
      maxNotesPerUpdate: 99,
      continueSeverity: "high",
      tools: "read",
    })
    expect(config.reviewMode).toBe("turn")
    expect(config.reviewInterval).toBe(1)
    expect(config.maxNotesPerUpdate).toBe(4)
    expect(config.continueSeverity).toBe("concern")
    expect(warnings.length).toBe(5)
  })

  test("parses provider/model with a variant and keeps slashes in model ids", () => {
    expect(parseModelSelector("anthropic/claude-sonnet-4-5#high")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
      variant: "high",
    })
    expect(parseModelSelector("openrouter/deepseek/deepseek-chat")).toEqual({
      providerID: "openrouter",
      id: "deepseek/deepseek-chat",
    })
    expect(parseModelSelector("broken")).toBeUndefined()
    expect(parseModelSelector("")).toBeUndefined()
  })
})

describe("emission guard", () => {
  test("normalizes punctuation and case", () => {
    expect(normalizeAdvisorNote("  *Stop.* ")).toBe("stop")
    expect(normalizeAdvisorNote("No issue; continue.")).toBe("no issue continue")
  })

  test("suppresses content-free notes", () => {
    const guard = new AdvisorEmissionGuard()
    guard.beginUpdate()
    expect(guard.admit("Stop.")).toEqual({ accepted: false, reason: "noise" })
    expect(guard.admit("LGTM")).toEqual({ accepted: false, reason: "noise" })
    expect(guard.admit("   ")).toEqual({ accepted: false, reason: "empty" })
  })

  test("dedupes equal or lower severity but allows escalation", () => {
    const guard = new AdvisorEmissionGuard()
    guard.beginUpdate()
    const note = "The null check in readConfig() is skipped for an empty file."
    expect(guard.admit(note, "nit").accepted).toBe(true)
    expect(guard.admit(note, "nit")).toEqual({ accepted: false, reason: "duplicate" })
    expect(guard.admit(note, "concern").accepted).toBe(true)
    expect(guard.admit(note, "concern")).toEqual({ accepted: false, reason: "duplicate" })
    expect(guard.admit(note, "blocker").accepted).toBe(true)
  })

  test("budgets non-blockers and lets a concern displace a pending nit", () => {
    const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 })
    guard.beginUpdate()
    expect(guard.admit("Rename the temporary variable for clarity.", "nit").accepted).toBe(true)
    expect(guard.admit("Add the missing import for the logger.", "nit")).toEqual({
      accepted: false,
      reason: "rate-limit",
    })
    const concern = guard.admit("The migration drops the index before the transaction commits.", "concern")
    expect(concern.accepted).toBe(true)
    expect(concern.displacedKey).toBe("rename the temporary variable for clarity")
  })

  test("blockers bypass the budget", () => {
    const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 })
    guard.beginUpdate()
    expect(guard.admit("Clean up the unused parameter.", "nit").accepted).toBe(true)
    expect(guard.admit("Write to the session file races the delete and recreates it.", "blocker").accepted).toBe(true)
  })
})

describe("transcript cursor", () => {
  const options = { includeReasoning: true, initialReplay: 2 }

  test("replays a bounded tail before the first commit", () => {
    const cursor = new TranscriptCursor()
    const batch = cursor.peek(
      [
        { id: "m1", type: "user", text: "old" },
        { id: "m2", type: "user", text: "new question" },
        { id: "m3", type: "assistant", content: [{ type: "text", text: "answer" }] },
      ],
      options,
    )
    expect(batch.reset).toBe(true)
    expect(batch.count).toBe(2)
    expect(batch.userCount).toBe(1)
    expect(batch.text).toContain("new question")
    expect(batch.text).not.toContain("old")

    cursor.commit(batch)
    const next = cursor.peek(
      [
        { id: "m1", type: "user", text: "old" },
        { id: "m2", type: "user", text: "new question" },
        { id: "m3", type: "assistant", content: [{ type: "text", text: "answer" }] },
        { id: "m4", type: "assistant", content: [{ type: "text", text: "more" }] },
      ],
      options,
    )
    expect(next.count).toBe(1)
    expect(next.text).toContain("more")
    expect(next.text).not.toContain("answer")
  })

  test("renders tool calls and hides advisor notes", () => {
    const cursor = new TranscriptCursor()
    const batch = cursor.peek(
      [
        {
          id: "m1",
          type: "assistant",
          content: [
            { type: "reasoning", text: "thinking" },
            {
              type: "tool",
              name: "read",
              state: { status: "completed", input: { path: "src/a.ts" }, content: [{ type: "text", text: "file body" }] },
            },
          ],
        },
        { id: "m2", type: "synthetic", text: "ignore me", metadata: { advisorNote: true } },
      ],
      options,
    )
    expect(batch.text).toContain("### Assistant reasoning")
    expect(batch.text).toContain("### Tool call: read")
    expect(batch.text).toContain("file body")
    expect(batch.text).not.toContain("ignore me")
    expect(batch.ids).toEqual(["m1", "m2"])
  })

  test("detects a rewritten transcript and replays", () => {
    const cursor = new TranscriptCursor()
    cursor.seed([{ id: "a", type: "user", text: "one" }])
    const batch = cursor.peek(
      [
        { id: "b", type: "user", text: "two" },
        { id: "c", type: "assistant", content: [{ type: "text", text: "three" }] },
      ],
      { includeReasoning: true, initialReplay: 5 },
    )
    expect(batch.reset).toBe(true)
    expect(batch.count).toBe(2)
  })
})
