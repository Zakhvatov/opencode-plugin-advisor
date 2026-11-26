# opencode-plugin-advisor

A second model watching every turn of an [OpenCode](https://opencode.ai) session.

The advisor reads the primary agent's transcript delta, checks the repository with read-only tools, and injects concise `<advisory>` notes back into the primary session. It is a port of the advisor subsystem in [oh-my-pi](https://github.com/can1357/oh-my-pi) (`WATCHDOG.md`, `WATCHDOG.yml`, the `advise` tool, severity routing, and the emission guard) to the OpenCode V2 plugin API.

> The primary agent decides. The advisor offers a view, raises a concern, or blocks work that is about to break. It never edits files.

```text
primary session ── step delta ──▶ advisor session ── read / grep / glob ──▶ advise(note, severity)
       ▲                                                                          │
       └──────────────────── synthetic <advisory> note ◀──── emission guard ◀─────┘
```

## Why

A coding agent that reviews its own work shares the blind spots that produced the work. A second model with its own context, its own model, and a read-only toolset catches what the doer rushed past: a wrong assumption, a missing constraint, a "done" that was never exercised.

The advisor is intentionally quiet. Silence is the preferred result; a review that finds nothing sends nothing.

## Requirements

- OpenCode **V2** (`opencode` 2.4 or newer; developed against 2.4.2)
- A provider/model for the advisor. A different model from the primary is recommended, but not required.

## Install

The package is not on npm yet. Point OpenCode at this directory:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-plugin-advisor",
      "options": {
        "model": "anthropic/claude-sonnet-4-5",
        "reviewMode": "turn"
      }
    }
  ]
}
```

Or install it per project under `.opencode/plugins/` and add the package to `plugins`.

Once published, it will be:

```sh
opencode plugin add opencode-plugin-advisor
```

## Configuration

All options are optional except `model`, which falls back to the primary session's model when omitted.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-plugin-advisor",
      "options": {
        "model": "anthropic/claude-sonnet-4-5#high",
        "reviewMode": "turn",
        "reviewInterval": 1,
        "maxNotesPerUpdate": 4,
        "continueSeverity": "concern",
        "tools": ["read", "grep", "glob"],
        "includeReasoning": true,
        "scope": "main",
        "watchdog": true,
        "instructions": "Pay special attention to transaction boundaries in src/db/.",
        "debug": false
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable the advisor subsystem. |
| `model` | primary model | Advisor model as `provider/model` with optional `#variant`. |
| `reviewMode` | `"turn"` | `turn` reviews every assistant step; `agent-end` reviews only terminal steps and idle boundaries. |
| `reviewInterval` | `1` | Review every Nth eligible update. Skipped updates are folded into the next review. |
| `maxNotesPerUpdate` | `4` | Non-blocker notes accepted per review (`1`–`32`). Blockers are exempt. |
| `continueSeverity` | `"concern"` | Lowest severity that may wake an idle primary session for one continuation. |
| `tools` | `["read","grep","glob"]` | Read-only tools granted to the advisor. |
| `instructions` | `""` | Extra advisor-only guidance, appended after `WATCHDOG.md`. |
| `includeReasoning` | `true` | Include the primary model's reasoning blocks in the reviewed delta. |
| `scope` | `"main"` | `main` watches top-level sessions only; `all` also watches subagent sessions. |
| `watchdog` | `true` | Load `WATCHDOG.md` files into the advisor prompt. |
| `minReviewGapMs` | `0` | Minimum wall-clock gap between reviews of the same session. |
| `maxReviewsPerRun` | `30` | Safety cap per primary run, reset by a new user message. |
| `reviewTimeoutMs` | `120000` | Interrupt an advisor turn that runs longer than this. |
| `initialReplay` | `20` | Messages replayed when the cursor starts or a transcript is rewritten. |
| `debug` | `false` | Log advisor lifecycle to the OpenCode server log. |

Set `ADVISOR_DEBUG_FILE=/absolute/path.log` to mirror debug lines into a file (useful for headless runs and tests).

## Watching the right things: `WATCHDOG.md`

`WATCHDOG.md` is advisor-only guidance. It is appended to the advisor's system prompt and never reaches the primary agent. Use it for review priorities, project-specific traps, and dangerous APIs.

Discovery order:

1. `~/.config/opencode/WATCHDOG.md` (or `$XDG_CONFIG_HOME/opencode/WATCHDOG.md`)
2. Every `WATCHDOG.md` and `.opencode/WATCHDOG.md` from the project root down to the session directory

```markdown
# Watchdog notes

Especially watch for:

- Changes that bypass the durable queue in `src/jobs/`.
- UI paths that render unsanitized tool output.
- New worker spawns that do not re-enter the CLI host.
```

`@path` imports are not expanded yet.

## Severities and delivery

The advisor calls `advise({ note, severity })`:

| Severity | Delivery |
| --- | --- |
| `nit` (or omitted) | Steers into the next model call if the primary is running; otherwise stays queued until the next user turn. |
| `concern` | Same as `nit` mid-run; wakes an idle primary for one continuation when `continueSeverity` is `concern` or lower. |
| `blocker` | Same as `concern`, but exempt from the per-review note budget and the concern cooldown. |

Notes are rendered into the primary transcript as:

```text
<advisory severity="concern" guidance="weigh, don't blindly obey">
The migration drops the index before the transaction commits.
</advisory>
```

An advisor-driven continuation does not re-arm itself. The advisor keeps reviewing the primary's response, but it cannot wake the session again until a real user message arrives.

## Emission guard

The prompt asks for quality; the guard makes it load-bearing:

- Empty and content-free notes (`stop`, `done`, `lgtm`, `no issue continue`, …) are dropped.
- Duplicates at equal or lower severity are dropped; a strictly higher severity is a real escalation.
- Non-blockers are limited per review. A concern can displace a pending nit from the same review; a blocker is never rate-limited.
- Every rejected note receives a truthful acknowledgment in the advisor's tool result.

## Commands

```text
/advisor          status
/advisor status   status
/advisor on       enable for this session
/advisor off      disable and interrupt the advisor
```

The status message includes the advisor model, cadence, review count, advisor session id, and the last error.

## How it maps to oh-my-pi

| oh-my-pi | Here |
| --- | --- |
| `advisor` model role | the `model` plugin option |
| `advisor.enabled` | the `enabled` option and `/advisor on|off` |
| `WATCHDOG.md` | same discovery shape, under the OpenCode config directory |
| `WATCHDOG.yml` roster | not ported yet; one advisor per session |
| `reviewMode` | same `turn` / `agent-end` semantics |
| `reviewInterval` | same, skipped deltas are folded into the next review |
| `advise` tool | same tool, same severity rubric, same guard |
| `maxNotesPerUpdate` | same budget, including rank-aware displacement |
| advisor transcript file | a real archived OpenCode session named `[advisor] <primary>` |
| `advisor.syncBacklog` | not ported; OpenCode has no blocking catch-up hook |
| backup reviewer / fallback chains | not ported; use OpenCode provider fallback |

See [`docs/omp-advisor.md`](docs/omp-advisor.md) for the notes from reading the original implementation.

## Cost and latency

Every review is a real model turn in its own session. In `turn` mode a long tool loop produces many reviews. Manage it with:

- `reviewMode: "agent-end"` for a single review per run;
- `reviewInterval: 2` or `3` to review every Nth step;
- `minReviewGapMs` to enforce a wall-clock floor;
- `maxReviewsPerRun` as a hard cap;
- a cheap advisor model, or a strong one only where it pays.

With `opencode run` (headless), the process can exit as soon as the primary is idle. Mid-run reviews finish; a final `agent-end` review may be cut off. Use `turn` mode for headless runs.

## Development

```sh
bun install
bun run check     # typecheck + unit tests
```

The integration harness used during development lives outside this repo: a temporary project with `opencode.json` pointing at this directory, a free model, and `ADVISOR_DEBUG_FILE` for diagnostics.

## License

MIT
