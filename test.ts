import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, TaskIndex, askChoice, decide, explicitReason, formatLog, type JudgeFn, type JudgeRequest, type SpawnEvent } from "./core";
import { findMagicKeyword } from "./plan";
import { register, type ExtensionContext } from "./register";

const config = { ...DEFAULT_CONFIG };
const currentModel = "anthropic/claude-sonnet-5-5";
const baseEvent: SpawnEvent = { agent: "task", invocationKind: "task", patterns: [`${currentModel}:high`], spawnKey: "sample" };
const when = new Date("2026-10-06T00:00:00.000Z");

// A scripted stand-in for omp's native judge. It enforces what the native cache and `judge()` normalizer need
// (string instructions, string criteria, one choice question) and records every call.
interface Script {
	choice?: string;
	confidence?: number;
	fail?: boolean;
}

function scripted(script: Script = {}) {
	const calls: JudgeRequest[] = [];
	const judge: JudgeFn = async (request) => {
		calls.push(request);
		const ids = Object.keys(request.questions);
		assert.equal(ids.length, 1, "exactly one question per judgment");
		const question = request.questions[ids[0]];
		assert.equal(question.type, "choice");
		assert.equal(typeof question.instructions, "string");
		assert.ok(Object.values(question.criteria).every((label) => typeof label === "string" && label.length > 0), "criteria must be strings");
		assert.ok(request.purpose.startsWith("jev-tier:"));
		if (script.fail) throw new Error("forced judge failure");
		const choice = script.choice ?? Object.keys(question.criteria)[0];
		return { answers: { [ids[0]]: { type: "choice", choice, probabilities: { [choice]: script.confidence ?? 0.9 }, confidence: script.confidence ?? 0.9 } } };
	};
	return { judge, calls };
}

function pending(task: string, context = "") {
	const index = new TaskIndex();
	index.remember({ context, tasks: [{ name: "sample", task }] });
	return index.take("sample");
}

// ---------------------------------------------------------------- subagent tier

async function runTierChecks(): Promise<void> {
	const cases = [
		{ task: "Design a cross-layer architecture for domain and API retry orchestration across src/domain/retry.ts and src/api/retry.ts", tier: "heavy" },
		{ task: "Fix the pagination boundary bug in src/pagination.ts", tier: "medium" },
		{ task: "Look up the config location and summarize it", tier: "quick" },
	] as const;
	const lines: string[] = [];
	for (const sample of cases) {
		const event = { ...baseEvent, spawnKey: `sample-${sample.tier}` };
		const { judge, calls } = scripted({ choice: sample.tier, confidence: 0.94 });
		const decision = await decide({ event, pending: pending(sample.task), currentModel, config, judge });
		assert.equal(decision.action, "apply");
		if (decision.action !== "apply") throw new Error("unexpected skip");
		assert.equal(decision.tier, sample.tier);
		assert.equal(calls.length, 1, "one judgment per spawn decision");
		lines.push(formatLog(decision, event, when));
	}

	const failureEvent = { ...baseEvent, spawnKey: "failure" };
	const failure = await decide({
		event: failureEvent,
		pending: { name: "failure", item: { task: "Fix a normal pagination bug" }, context: "", at: Date.now(), consumed: true },
		currentModel,
		config,
		judge: scripted({ fail: true }).judge,
	});
	assert.equal(failure.action, "skip");
	assert.match(failure.reason, /forced judge failure/);
	lines.push(formatLog(failure, failureEvent, when));

	const floor = await decide({ event: baseEvent, pending: pending("Update the unit tests and run npm test"), currentModel, config, judge: scripted({ choice: "quick" }).judge });
	assert.equal(floor.action, "apply");
	if (floor.action === "apply") assert.equal(floor.tier, "medium");

	const secret = await decide({ event: baseEvent, pending: pending("Summarize API_KEY=secret-value-1234567890 and auth config"), currentModel, config, judge: scripted({ choice: "quick" }).judge });
	assert.ok(!formatLog(secret, baseEvent).includes("secret-value-1234567890"));
	console.log(lines.join("\n"));
	console.log("PASS tier: heavy / medium / quick, judge failure fail-open, test floor, log redaction, native question shape");
}

// The default `task` agent resolves through the `task` role; that alone is not a pin.
async function runPinChecks(): Promise<void> {
	const task = "Fix the pagination boundary bug in src/pagination.ts";
	const taskRole = { ...baseEvent, modelRole: "task" };
	assert.equal(explicitReason(taskRole, { task }, currentModel), undefined, "task role resolving to the parent's model is not a pin");
	assert.match(explicitReason({ ...taskRole, patterns: ["openai-codex/gpt-6-luna:high"] }, { task }, currentModel) ?? "", /pinned/, "task role pointing elsewhere stays protected");
	assert.match(explicitReason({ ...baseEvent, modelRole: "smol" }, { task }, currentModel) ?? "", /pinned a role \(smol\)/);
	assert.match(explicitReason(baseEvent, { task, model: "@smol" }, currentModel) ?? "", /explicit model/);
	const { judge, calls } = scripted({ choice: "heavy", confidence: 0.9 });
	const decision = await decide({ event: taskRole, pending: pending(task), currentModel, config, judge });
	assert.equal(decision.action, "apply");
	assert.equal(calls.length, 1);
	console.log("PASS pins: task role is not a pin; other roles, differing models and explicit models still are");
}

// ---------------------------------------------------------------- timeout

async function runTimeoutCheck(): Promise<void> {
	const started = Date.now();
	const hung: JudgeFn = () => Promise.withResolvers<never>().promise; // never settles, ignores the abort signal
	await assert.rejects(
		askChoice({
			judge: hung,
			state: { message: "x" },
			questionId: "plan_route",
			question: { type: "choice", instructions: "q", criteria: { plan: "a", direct: "b" } },
			choices: ["plan", "direct"] as const,
			purpose: "jev-tier:test",
			timeoutMs: 80,
		}),
		/timeout after 80ms/,
	);
	assert.ok(Date.now() - started < 1000, "timeout must cap the wait");
	console.log(`PASS timeout: a hung judge settles after ${Date.now() - started}ms (cap 80ms in this test, 3000ms in production)`);
}

// ---------------------------------------------------------------- magic keywords

function runKeywordChecks(): void {
	for (const text of ["jevify commit abc for unrelated changes", "please orchestrate, then report", "use workflowz here.", '"ultrathink" about this']) {
		assert.ok(findMagicKeyword(text), text);
	}
	for (const text of ["Orchestrate this", "orchestrated runs", "see orchestrate.ts", "call orchestrate()", "foo::orchestrate", "a `jevify` span", "```\njevify\n```", "<b>workflowz</b>", "re-orchestrate", "src/jevify/x.ts"]) {
		assert.equal(findMagicKeyword(text), undefined, text);
	}
	assert.equal(findMagicKeyword("jevify a"), "jevify");
	assert.equal(findMagicKeyword("jevify b"), "jevify", "matcher must be stateless between calls");
	console.log("PASS keywords: omp's matching rules (case, glued words, code spans, call syntax)");
}

// ---------------------------------------------------------------- hooks through the real register()

const approvedPlanEntries = [
	{ type: "mode_change", mode: "plan" },
	{ type: "mode_change", mode: "none" },
	{
		type: "message",
		message: {
			role: "developer",
			attribution: "agent",
			synthetic: true,
			content: [{ type: "text", text: 'Plan approved.\n- History usable; the plan below authoritative.\n\n<plan path="local://PLAN.md">1. do it</plan>' }],
		},
	},
];

interface Scenario extends Script {
	mode?: string;
	entries?: readonly unknown[];
	idle?: boolean;
	agentKind?: string;
	magicActive?: boolean;
}

const logFile = join(tmpdir(), "jev-tier-test.log");
type Handler = (event: unknown, context: ExtensionContext) => unknown;

function harness(scenario: Scenario = {}) {
	const handlers: Record<string, Handler> = {};
	const { judge, calls } = scripted(scenario);
	register(
		{ on: (event, handler) => void (handlers[event] = handler) },
		{
			planModeAvailable: () => true,
			magicKeywordActive: () => scenario.magicActive ?? true,
			judge: (_context, request) => judge(request),
			logPath: logFile,
		},
	);
	const notices: string[] = [];
	const context: ExtensionContext = {
		mode: "tui",
		agent: { kind: scenario.agentKind ?? "main" },
		isIdle: () => scenario.idle ?? true,
		ui: { notify: (message) => void notices.push(message) },
		setTimeout: (callback) => void callback(), // omp's managed timer; run inline so notices are observable
		models: { current: () => ({ provider: "anthropic", id: "claude-sonnet-5-5" }) },
		sessionManager: { buildSessionContext: () => ({ mode: scenario.mode ?? "none" }), getEntries: () => scenario.entries ?? [] },
	};
	return { handlers, calls, notices, context };
}

async function sendMessage(text: string, scenario: Scenario = {}) {
	const { handlers, calls, notices, context } = harness(scenario);
	const result = (await handlers.input({ text, source: "interactive" }, context)) as { text?: string } | undefined;
	return { result, calls, notices };
}

async function runPlanChecks(): Promise<void> {
	rmSync(logFile, { force: true });
	delete process.env.JEV_TIER;
	delete process.env.JEV_PLAN;

	// 1. clear plan case -> input rewritten to /plan <message>, one-line notice, exactly one judgment
	const planText = "Add retry and idempotency handling to the sync job across src/api/sync.ts and src/worker/sync.ts";
	const plan = await sendMessage(planText, { choice: "plan", confidence: 0.93 });
	assert.equal(plan.result?.text, `/plan ${planText}`);
	assert.deepEqual(plan.notices, ["Plan mode: multi-file scope"]);
	assert.equal(plan.calls.length, 1);
	assert.deepEqual(Object.keys(plan.calls[0].questions), ["plan_route"]);
	assert.equal(plan.calls[0].state.message, planText);

	// 2. direct case -> straight through
	const direct = await sendMessage("What does the retry policy in src/sync.ts do?", { choice: "direct", confidence: 0.96 });
	assert.equal(direct.result, undefined);
	assert.deepEqual(direct.notices, []);
	assert.equal(direct.calls.length, 1);

	// 3. in-prompt opt-out, omp command/shortcut syntax -> no judgment, untouched
	const optOut = await sendMessage("Refactor the sync job across the API and worker, just do it", { choice: "plan", confidence: 0.99 });
	assert.equal(optOut.result, undefined);
	assert.equal(optOut.calls.length, 0);
	for (const passthrough of ["!git status", "!!ls", "/model @smol", "$ print(1)"]) {
		const r = await sendMessage(passthrough, { choice: "plan", confidence: 0.99 });
		assert.equal(r.result, undefined, passthrough);
		assert.equal(r.calls.length, 0, passthrough);
	}

	// 4. magic keyword present -> omp already decides how the message runs: no judgment, untouched
	for (const keyword of ["jevify", "orchestrate", "workflowz", "ultrathink"]) {
		const r = await sendMessage(`${keyword} the migration of the sync job across the API and worker`, { choice: "plan", confidence: 0.99 });
		assert.equal(r.result, undefined, keyword);
		assert.equal(r.calls.length, 0, keyword);
	}
	const glued = await sendMessage("Refactor src/orchestrate.ts and the worker, call orchestrate() less", { choice: "plan", confidence: 0.99 });
	assert.equal(glued.result?.text?.startsWith("/plan "), true, "glued words are not keywords");
	const disabled = await sendMessage("jevify the migration across the API and worker", { choice: "plan", confidence: 0.99, magicActive: false });
	assert.equal(disabled.result?.text?.startsWith("/plan "), true, "keyword switched off in omp settings: detection proceeds");

	// 5. judge failure -> falls open
	const failed = await sendMessage(planText, { fail: true });
	assert.equal(failed.result, undefined);
	assert.deepEqual(failed.notices, []);
	assert.equal(failed.calls.length, 1);

	// 6. already in plan mode (or any non-"none" mode) -> no switch, no judgment; /plan would toggle it OFF
	for (const mode of ["plan", "plan_paused", "goal", "vibe"]) {
		const r = await sendMessage(planText, { mode, choice: "plan", confidence: 0.99 });
		assert.equal(r.result, undefined, mode);
		assert.equal(r.calls.length, 0, mode);
	}

	// 7. executing an approved plan -> no switch, no judgment; abandoning a later plan session clears that
	const executing = await sendMessage(planText, { entries: approvedPlanEntries, choice: "plan", confidence: 0.99 });
	assert.equal(executing.result, undefined);
	assert.equal(executing.calls.length, 0);
	const abandoned = await sendMessage(planText, { entries: [...approvedPlanEntries, { type: "mode_change", mode: "plan" }, { type: "mode_change", mode: "none" }], choice: "plan", confidence: 0.9 });
	assert.equal(abandoned.result?.text, `/plan ${planText}`);

	// 8. thresholds, busy agent, subagent, toggles
	assert.equal((await sendMessage(planText, { choice: "plan", confidence: 0.74 })).result, undefined);
	assert.equal((await sendMessage(planText, { choice: "plan", confidence: 0.75 })).result?.text, `/plan ${planText}`);
	const busy = await sendMessage(planText, { idle: false, choice: "plan", confidence: 0.99 });
	assert.equal(busy.result, undefined);
	assert.equal(busy.calls.length, 0);
	const sub = await sendMessage(planText, { agentKind: "sub", choice: "plan", confidence: 0.99 });
	assert.equal(sub.result, undefined);
	assert.equal(sub.calls.length, 0);
	process.env.JEV_PLAN = "off";
	const planOff = await sendMessage(planText, { choice: "plan", confidence: 0.99 });
	assert.equal(planOff.result, undefined);
	assert.equal(planOff.calls.length, 0);
	delete process.env.JEV_PLAN;
	process.env.JEV_TIER = "off";
	const tierOff = await sendMessage(planText, { choice: "plan", confidence: 0.99 });
	assert.equal(tierOff.result, undefined);
	assert.equal(tierOff.calls.length, 0);
	delete process.env.JEV_TIER;

	const log = readFileSync(logFile, "utf8");
	assert.ok(log.split("\n").every((line) => !line || line.includes("kind=plan")));
	console.log("PASS plan: switch, direct, opt-out + untouched !/ shortcuts, magic keywords, judge failure, already planning, approved plan, thresholds, toggles");
}

// At most one judgment per message and per spawn for the same decision, driven through the real hooks.
async function runSingleCallChecks(): Promise<void> {
	const message = harness({ choice: "plan", confidence: 0.9 });
	await message.handlers.input({ text: "Add retry handling to the sync job across src/a.ts and src/b.ts", source: "interactive" }, message.context);
	assert.equal(message.calls.length, 1, "one judgment for one message");

	const spawn = harness({ choice: "heavy", confidence: 0.9 });
	spawn.handlers.tool_call({ toolName: "task", input: { context: "c", tasks: [{ name: "once", agent: "task", task: "Design the retry model across API and worker layers" }] } }, spawn.context);
	const routed = (await spawn.handlers.before_subagent_spawn({ ...baseEvent, modelRole: "task", spawnKey: "once" }, spawn.context)) as { model?: string } | undefined;
	assert.equal(routed?.model, "@slow");
	assert.equal(spawn.calls.length, 1, "one judgment for one spawn");
	assert.deepEqual(Object.keys(spawn.calls[0].questions), ["model_tier"]);
	// the same spawn key asked about again (e.g. a retried dispatch) has no new task text to judge from, so it never doubles up
	const again = (await spawn.handlers.before_subagent_spawn({ ...baseEvent, modelRole: "task", spawnKey: "once" }, spawn.context)) as { model?: string } | undefined;
	assert.equal(again?.model, "@slow", "consumed entry is reused, still one judgment per dispatch");
	console.log("PASS single-call: 1 judgment per message, 1 per spawn (a second dispatch of the same key judges once more, by design)");
}

await runTierChecks();
await runPinChecks();
await runTimeoutCheck();
runKeywordChecks();
await runPlanChecks();
await runSingleCallChecks();
console.log(`\n--- plan log lines from this run (${logFile}) ---`);
console.log(readFileSync(logFile, "utf8").trimEnd());
