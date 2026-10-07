# Jev router (subagent tiers + automatic plan mode)

One user-level omp extension; nothing in omp is patched and your model roles, fallback chains and usage reserve are untouched. Both features ask Jev one Choice question per decision through **omp's own judge** (`@oh-my-pi/pi-coding-agent/judgment`), the same plumbing the auto-thinking classifier and `judge()` use:

- the `judge` model role and its chain (default `typesafe/jev-latest` first), credentials from `TYPESAFE_API_KEY` or `/login typesafe`, gateway `baseUrl` honoured;
- omp's shared judgment cache (`~/.omp/cache/judgment-cache.db`): an identical state + question is not billed twice;
- usage journaling and telemetry like any other native judgment (purpose `jev-tier:model_tier` / `jev-tier:plan_route`).

Only a native Jev candidate may answer. If the `judge` role would resolve to a prompted chat or on-device model, the judgment is refused rather than turning a cheap Jev decision into a paid LLM call. Everything fails open: a judge error, a 3s cap (`AbortSignal` plus a hard race), or low confidence leaves omp exactly as it would have behaved.

Files: `index.ts` (omp entry: native judge, `plan.enabled` and magic-keyword settings), `register.ts` (hooks, logging), `core.ts` (subagent tiers, `askChoice`), `plan.ts` (plan detection), `test.ts` (mocked harness).

## 1. Subagent tier (`before_subagent_spawn`)

Picks heavy / medium / quick per spawn and returns `@slow` / `@default` / `@smol`. The spawn event carries no task text, so task-tool inputs are captured from `tool_call` and matched on `spawnKey`; eval `agent()` spawns and unnamed tasks fail open. Confidence floor 0.7; a quick verdict for work that runs tests is raised to medium.

Never overridden: an explicit `model` on the task call, an agent that pins a role other than `task` (e.g. `scout` = `smol`), and any spawn whose resolved model differs from the parent's (catches `task.agentModelOverrides` and a `modelRoles.task` pointing elsewhere). The default agent's own `task` role is not a pin by itself.

## 2. Automatic plan mode (`input`)

On each message you submit in the main session's interactive TUI, Jev judges `plan` vs `direct`. A message that plainly asks for a plan ("make/write/create a plan", "plan this/out", "let's plan", "plan first", unless negated in the same clause) switches without calling Jev. Otherwise, on a Jev `plan` verdict with confidence >= 0.6 the hook rewrites the input to `/plan <your message>`, the path the slash command takes. A `Plan mode: <reason>` line follows omp's own `Plan mode enabled` line. As with a manual `/plan`, omp switches to your `plan` role model.

It never acts when: the session is in plan, paused plan, goal or vibe mode; an approved plan is being executed; the agent is busy; `plan.enabled` is off; this is a subagent session; the message starts with omp syntax (`/`, `!`, `!!`, `$`, `->`, `=>`); or the message contains an omp magic keyword (`jevify`, `orchestrate`, `workflowz`, `ultrathink`, matched by omp's own rules and only while `magicKeywords.enabled` and the keyword's switch are on).

To skip detection for one message, say so in it: "no plan", "skip planning", "don't plan", "without a plan" or "just do it".

## How it relates to omp's native Jev features

| Native feature | Decision | Overlap with this extension |
| --- | --- | --- |
| `judge` role | which model answers judgments | reused, not duplicated |
| auto thinking level (`defaultThinkingLevel: auto`, bundled `task` agent) | reasoning effort, from `solutionSpace` | adjacent: one extra Jev call per default-agent spawn, different question (`level`); composes with the tier because effort is resolved after my model choice |
| Smart unexpected-stop (`features.unexpectedStopDetection: smart`) | did the agent stop early | none (yours is `mechanical`: no Jev call) |
| `find` tool, TTSR judged rules, git staging, `omp stats` frustration | search / rule / staging / tone | none; they spend from the same Jev budget |
| `judge()` / `judge_batch()` eval helpers, `jevify` keyword | bulk classification | none; plan detection steps aside for `jevify` messages |
| `advisor.judgeGate` | n/a | does not exist in omp 18.6.3 |

## Log

`~/.omp/agent/logs/jev-tier.log`, one line per decision, mode 0600. Subagent lines show spawn/agent/tier; plan lines start `kind=plan` and show `verdict`, `conf`, `action=switched|skipped`, `reason`, and the first 80 characters of the message.

## Turn it off

- Whole extension: `JEV_TIER=off omp`.
- Plan detection only: `JEV_PLAN=off`.
- Persistent: `~/.omp/agent/extensions/jev-tier/config.json`, e.g. `{"enabled": false}` or `{"planEnabled": false}`. Tuning keys: `timeoutMs` (1-3000; the plan check scales it up to 8s as the message grows from 500 to 2000 characters; a timeout fails open and is logged as `jev error: timeout after Nms`), `minConfidence` (tiers, 0.7), `planMinConfidence` (0.6).

## Test

`cd ~/.omp/agent/extensions/jev-tier && bun test.ts`. A scripted judge stands in for omp's, so there is no network; it drives the real hook handlers and writes to `/tmp/jev-tier-test.log`, not your log.
