import { beforeEach, describe, expect, test } from "bun:test"
import plugin from "../src/index"
import { shared } from "../src/state"
import { createState } from "../src/state"

function baseContext(options: unknown) {
  const tools: any[] = []
  const commands: any[] = []
  const hooks: { name: string; callback: Function }[] = []
  const synthetics: any[] = []

  const ctx: any = {
    app: { version: "test" },
    location: { directory: "/tmp/advisor-test", project: { canonical: "/tmp/advisor-test" } },
    options,
    tool: {
      transform: async (callback: Function) => {
        callback({
          add: (tool: any) => tools.push(tool),
          list: () => tools,
          get: (id: string) => tools.find((tool) => tool.name === id),
        })
      },
    },
    command: {
      transform: async (callback: Function) => {
        callback({ add: (command: any) => commands.push(command) })
      },
    },
    session: {
      hook: async (name: string, callback: Function) => {
        hooks.push({ name, callback })
        return { dispose: async () => undefined }
      },
      context: async () => [],
      get: async () => ({
        id: "ses_primary",
        title: "Primary",
        location: { directory: "/tmp/advisor-test" },
        model: { providerID: "test", id: "model" },
      }),
      create: async () => ({ id: "ses_advisor" }),
      update: async () => undefined,
      prompt: async () => undefined,
      wait: async () => undefined,
      synthetic: async (input: any) => {
        synthetics.push(input)
      },
      interrupt: async () => ({ interrupted: true }),
      remove: async () => undefined,
    },
    event: {
      subscribe: async function* () {
        // No events in this unit test.
      },
    },
    model: { default: async () => ({ data: { providerID: "test", id: "model" } }) },
  }

  return { ctx, tools, commands, hooks, synthetics }
}

beforeEach(() => {
  const registry = shared()
  registry.claims.clear()
  registry.states.clear()
  registry.advisors.clear()
  registry.disabled.clear()
})

describe("plugin wiring", () => {
  test("registers the advise tool and the /advisor command", async () => {
    const { ctx, tools, commands } = baseContext({ model: "test/model" })
    const cleanup = await plugin.setup(ctx)
    expect(tools.map((tool) => tool.name)).toContain("advise")
    expect(commands.map((command) => command.name)).toContain("advisor")
    await cleanup?.()
  })

  test("/advisor reports status and toggles the session", async () => {
    const { ctx, commands, synthetics } = baseContext({ model: "test/model" })
    const cleanup = await plugin.setup(ctx)
    const command = commands.find((item) => item.name === "advisor")!

    await command.execute({ sessionID: "ses_primary", prompt: { text: "status" } })
    expect(synthetics.at(-1).text).toContain("Advisor: on")

    await command.execute({ sessionID: "ses_primary", prompt: { text: "off" } })
    expect(synthetics.at(-1).text).toContain("disabled")
    expect(shared().disabled.has("ses_primary")).toBe(true)

    await command.execute({ sessionID: "ses_primary", prompt: { text: "on" } })
    expect(synthetics.at(-1).text).toContain("enabled")
    expect(shared().disabled.has("ses_primary")).toBe(false)

    await cleanup?.()
  })

  test("advise is rejected outside an advisor session", async () => {
    const { ctx, tools } = baseContext({})
    const cleanup = await plugin.setup(ctx)
    const advise = tools.find((tool) => tool.name === "advise")
    const result = await advise.execute(
      { note: "Check the null guard in readConfig().", severity: "concern" },
      { sessionID: "ses_primary" },
    )
    expect(result.content).toContain("not a watched advisor session")
    await cleanup?.()
  })

  test("context hook trims advisor tools and appends the advisor system prompt once", async () => {
    const { ctx, hooks } = baseContext({})
    const cleanup = await plugin.setup(ctx)

    const state = createState("ses_primary", 4)
    shared().advisors.set("ses_advisor", {
      state,
      runtime: { admit: () => ({ accepted: true }) },
    })

    const contextHook = hooks.find((hook) => hook.name === "context")!
    const advisorEvent = {
      sessionID: "ses_advisor",
      agent: "build",
      system: [] as any[],
      messages: [],
      tools: {
        read: {},
        grep: {},
        glob: {},
        shell: {},
        write: {},
        advise: {},
      },
      options: {},
    }
    await contextHook.callback(advisorEvent)
    expect(Object.keys(advisorEvent.tools).sort()).toEqual(["advise", "glob", "grep", "read"])
    expect(advisorEvent.system.length).toBe(1)
    expect(advisorEvent.system[0].text).toContain("opencode-advisor-role")

    await contextHook.callback(advisorEvent)
    expect(advisorEvent.system.length).toBe(1)

    const primaryEvent = {
      sessionID: "ses_primary",
      agent: "build",
      system: [],
      messages: [],
      tools: { read: {}, advise: {} },
      options: {},
    }
    await contextHook.callback(primaryEvent)
    expect(Object.keys(primaryEvent.tools)).toEqual(["read"])
    expect(primaryEvent.system.length).toBe(0)

    await cleanup?.()
  })
})
