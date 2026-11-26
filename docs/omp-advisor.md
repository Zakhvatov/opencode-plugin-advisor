# Notes: how oh-my-pi implements the advisor

These notes come from reading `can1357/oh-my-pi` at commit time November 2026:

- `docs/advisor-watchdog.md`
- `packages/coding-agent/src/advisor/runtime.ts`
- `packages/coding-agent/src/advisor/advise-tool.ts`
- `packages/coding-agent/src/advisor/emission-guard.ts`
- `packages/coding-agent/src/prompts/advisor/system.md`

They explain what this plugin ports and what it deliberately leaves out.

## The shape of the subsystem

An advisor is a second agent attached to a primary session. It is not a subagent and not a peer:

- It has its own `Agent`, its own model, its own append-only context, and its own tool session (`ToolSession` with an `-advisor` suffix).
- It does not share the primary's snapshots, seen-lines tracking, conflict state, or summary cache.
- It cannot approve actions and cannot mutate primary session state directly.
- Its only output channel is the `advise` tool, which renders notes into the primary transcript as `<advisory>` elements.

Default investigative tools: `read`, `grep`, `glob`, plus `recall` when a memory backend exists. A `WATCHDOG.yml` roster can grant anything, including mutating tools, but the default grant is read-only.

## Per-turn review loop

`AdvisorRuntime.onTurnEnd(messages, { willContinue, dispatch })` is called at every primary turn boundary. The runtime:

1. Renders only the new transcript delta since its cursor. Reasoning, tool intent, tool arguments and tool results are included; hidden `custom` messages collapse to a summary. Advisories already injected into the primary are filtered out, so the advisor never reviews its own advice.
2. Appends the delta to the advisor's own context and runs one advisor agent turn.
3. The advisor model may call read-only tools to verify a suspicion, then calls `advise` zero or more times.
4. Accepted notes are batched and delivered at a boundary.

On compaction, session switch/resume, forks, or context re-priming, the runtime resets its private transcript and cursor. The next review replays the current bounded primary transcript. Enabling the advisor mid-session seeds the cursor to the current transcript end so old history is not replayed.

Cadence:

- `turn` reviews every primary turn, including tool-loop continuations.
- `agent-end` reviews only final yields.
- `reviewInterval: N` reviews every Nth eligible update; skipped updates are captured and sent with the next scheduled review.

## What the advisor sees

- New primary delta only, not the whole conversation every time.
- Assistant reasoning (`_thinking:_` blocks) unless `includeReasoning: false`.
- Tool calls with arguments and results, rendered as transcript evidence.
- Project context files (`AGENTS.md` and friends) as a `<project-context>` system block.
- `WATCHDOG.md` appended to the system prompt as `<attention>`.
- Secret values obfuscated before reaching the advisor.

## `advise` and severity routing

The tool takes `{ note, severity?: "nit" | "concern" | "blocker" }`.

Delivery depends on whether the primary is streaming or idle, and on how the current run ended:

- `nit`: non-interrupting aside, batched into the primary transcript at the next turn boundary. After a terminal answer it becomes a visible card instead of waking the agent.
- `concern` / `blocker`: interrupting steering when constraints permit. After a terminal answer, `advisor.continueSeverity` (default `concern`) decides whether to request one continuation or leave a visible card.
- A blocker is exempt from the per-review note budget and from the concern cooldown (`advisor.immuneTurns`, default 3).
- Plan mode and clients that defer agent-initiated turns preserve notes as cards instead of steering.
- A deliberate user interrupt disables auto-resume; later notes are preserved until the user resumes.

Notes render as:

```text
<advisory advisor="Architecture" severity="concern" guidance="weigh, don't blindly obey">
Cross-module coupling grew; the new public API duplicates the router.
</advisory>
```

Guidance is carried as an XML attribute rather than a prose header so the agent-facing block stays clean. The primary system prompt never mentions advisories; this attribute is the only cue.

## Emission guard

The prompt states a per-update budget and no-repeat rules, but real models violate them. Issue #3520 recorded 309 `advise` calls covering 92 unique notes, including 114 `Stop.` and 41 `Done.` The guard makes the rules executable:

1. **Normalization**: lowercase, NFKC, collapse non-alphanumerics to spaces. `"Stop."`, `"*Stop*"` and `"  stop  "` all key to `stop`.
2. **Noise filter**: short, content-free phrases (`stop`, `done`, `complete`, `lgtm`, `no issue continue`, …) are suppressed.
3. **Rank-aware dedupe**: a repeated note at equal or lower severity is dropped; a strictly higher severity (`nit → concern → blocker`) is a real escalation and is admitted. FIFO history holds 4096 entries.
4. **Per-update budget**: up to N non-blockers per advisor `prompt()` cycle (default 4, max 32). At capacity, a higher-severity note can displace the lowest-rank still-pending note from the same update. Routed notes keep their slots; blockers are exempt.
5. **Truthful acknowledgments**: every call gets accepted / deferred / duplicate / noise / rate-limit, so the advisor cannot believe a rejected note was delivered.

The guard clears on advisor reset (compaction, session switch, `/new`), so a re-primed reviewer can re-raise issues against the rewritten transcript.

## Catch-up, failure and cost

- `advisor.syncBacklog` (`off`, `1`, `3`, `5`, `strict`) decides how long the primary waits for scheduled advisor reviews. `strict` + `agent-end` gives synchronous final review. Default `off`.
- Failures retry with credential rotation and fallback chains; three dropped backlogs halt the runtime until an explicit reset. A quota pause keeps the batch and does not auto-resume.
- Advisor usage is separate model usage, with its own cost ledger. Investigative tool results from older reviews are evicted before the next review to bound context.
- Every finalized advisor turn is appended to `__advisor[.<slug>].jsonl`, so usage and transcripts are observable per session.

## What this plugin keeps

- Delta-based review with its own cursor and replay after a transcript rewrite.
- A real separate session and model for the advisor.
- Read-only tools for verification (`read`, `grep`, `glob`).
- `advise` with the same severity rubric and the same emission guard semantics.
- `turn` / `agent-end` cadence and interval folding.
- `WATCHDOG.md` discovery and advisor-only prompt injection.
- Truthful tool acknowledgments and a per-review budget.
- One-continuation arming: an advisor-driven resume cannot re-arm itself; a real user message does.

## What it leaves out (for now)

- `WATCHDOG.yml` roster with multiple named advisors, per-advisor models/tools/prompts, and scopes.
- `syncBacklog` / strict final review, because OpenCode V2 has no hook that blocks the primary's completion on a background plugin task.
- Backup reviewer and provider fallback chains; use OpenCode's provider fallback instead.
- Quarantine of unsafe advisor output, tool-loop guards, context promotion and advisor-specific compaction.
- JSONL transcripts and cost attribution; the advisor is a real archived OpenCode session instead.
- `@path` imports inside `WATCHDOG.md`.
