import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, TIMEOUT_CAP_MS, TaskIndex, askChoice, decide, explicitReason, formatLog, parseConfig, spawnTimeoutMs, type JudgeFn, type JudgeRequest, type SpawnEvent } from "./core";
import { explicitPlanRequest, findMagicKeyword, planTimeoutMs } from "./plan";
import { register, type ExtensionContext } from "./register";

const config = { ...DEFAULT_CONFIG };
const currentModel = "anthropic/claude-sonnet-5-5";
const baseEvent: SpawnEvent = { agent: "task", invocationKind: "task", patterns: [`${currentModel}:high`], spawnKey: "sample" };
const when = new Date("2026-10-06T00:00:00.000Z");

// A scripted stand-in for omp's native judge. It enforces what the native cache and `judge()` normalizer need
// (string instructions, string criteria, choice questions) and records every call.
interface Script {
	choice?: string;
	confidence?: number;
	fail?: boolean;
	/** Resolve this many ms late; ignores the abort signal, like a slow network call. */
	delayMs?: number;
	/** Per question id answers, overriding `choice`/`confidence`. */
	perQuestion?: Record<string, { choice: string; confidence: number }>;
	/** Question ids left out of the answer, like an unusable response. */
	omit?: string[];
}

function scripted(script: Script = {}) {
	const calls: JudgeRequest[] = [];
	const judge: JudgeFn = async (request) => {
		calls.push(request);
		const ids = Object.keys(request.questions);
		assert.ok(ids.length >= 1, "at least one question per judgment");
		for (const id of ids) {
			const question = request.questions[id];
			assert.equal(question.type, "choice");
			assert.equal(typeof question.instructions, "string");
			assert.ok(Object.values(question.criteria).every((label) => typeof label === "string" && label.length > 0), "criteria must be strings");
		}
		assert.ok(request.purpose.startsWith("jev-tier:"));
		if (script.fail) throw new Error("forced judge failure");
		if (script.delayMs) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, script.delayMs);
			await promise;
		}
		const answers = Object.fromEntries(
			ids
				.filter((id) => !script.omit?.includes(id))
				.map((id) => {
					const choice = script.perQuestion?.[id]?.choice ?? script.choice ?? Object.keys(request.questions[id].criteria)[0];
					const confidence = script.perQuestion?.[id]?.confidence ?? script.confidence ?? 0.9;
					return [id, { type: "choice", choice, probabilities: { [choice]: confidence }, confidence }];
				}),
		);
		return { answers };
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

	const testWriting = scripted({ choice: "quick", confidence: 0.9 });
	const written = await decide({
		event: baseEvent,
		pending: pending("Add unit tests for slugify in test/slugify.test.ts following the existing cases, then run bun test"),
		currentModel,
		config,
		judge: testWriting.judge,
	});
	assert.equal(written.action, "apply");
	if (written.action === "apply") {
		assert.equal(written.tier, "quick");
		assert.equal(written.model, "@smol");
		assert.equal(written.reason, "jev choice");
	}
	const tierInstructions = testWriting.calls[0].questions.model_tier.instructions;
	assert.match(tierInstructions, /writes or extends tests following existing patterns can be quick/);
	assert.match(tierInstructions, /Debugging failing tests, fixing flaky tests, or test-infrastructure changes are medium or above/);
	assert.match(tierInstructions, /When unsure between two tiers, pick the higher one/);
	assert.doesNotMatch(tierInstructions, /never quick/);

	const secret = await decide({ event: baseEvent, pending: pending("Summarize API_KEY=secret-value-1234567890 and auth config"), currentModel, config, judge: scripted({ choice: "quick" }).judge });
	assert.ok(!formatLog(secret, baseEvent).includes("secret-value-1234567890"));
	console.log(lines.join("\n"));
	console.log("PASS tier: heavy / medium / quick, judge failure fail-open, test-writing can be quick, log redaction, native question shape");
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

// ---------------------------------------------------------------- spawn timeout scaling

async function runTimeoutScalingChecks(): Promise<void> {
	for (const [base, chars, expected] of [
		[3000, 0, 3000],
		[3000, 1000, 3000],
		[3000, 4500, 5500],
		[3000, 8000, 8000],
		[3000, 50_000, 8000],
		[5000, 4500, 6500],
	] as const) {
		assert.equal(spawnTimeoutMs(base, chars), expected, `spawnTimeoutMs(${base}, ${chars})`);
	}
	assert.equal(parseConfig({ timeoutMs: 6000 }).timeoutMs, 6000);
	assert.equal(parseConfig({ timeoutMs: 20_000 }).timeoutMs, TIMEOUT_CAP_MS, "config may raise the timeout but never past the 8s cap");
	assert.equal(parseConfig({ timeoutMs: 0 }).timeoutMs, 3000);
	assert.equal(parseConfig({ timeoutMs: "x" }).timeoutMs, 3000);

	// ~2.2k characters of state: Jev answers after 3.2s, past the 3s base but inside the scaled ~3.9s.
	const longTask = "Adjust the importer carefully. ".repeat(50);
	const long = await decide({
		event: baseEvent,
		pending: pending(longTask, "Shared background. ".repeat(32)),
		currentModel,
		config,
		judge: scripted({ choice: "medium", confidence: 0.9, delayMs: 3200 }).judge,
	});
	assert.equal(long.action, "apply", "a long task must not time out at the 3s base");
	const short = await decide({ event: baseEvent, pending: pending("Fix the typo in src/a.ts"), currentModel, config, judge: scripted({ choice: "medium", confidence: 0.9, delayMs: 3300 }).judge });
	assert.equal(short.action, "skip");
	assert.match(short.reason, /jev error: timeout after 3000ms/, "a short state keeps the base cap");
	console.log("PASS timeout scaling: spawn timeout grows with state size, config capped at 8s, long task survives 3.2s Jev, short task still capped at 3s");
}

// ---------------------------------------------------------------- batched spawn tiering

async function runBatchChecks(): Promise<void> {
	rmSync(logFile, { force: true });
	delete process.env.JEV_TIER;
	delete process.env.JEV_PLAN;
	type Routed = { model?: string } | undefined;
	const item = (name: string, extra: Record<string, unknown> = {}) => ({ name, agent: "task", task: `Work item ${name}: adjust src/${name}.ts`, ...extra });
	const send = (h: Harness, tasks: unknown[], context = "Shared batch context") =>
		h.handlers.tool_call({ toolName: "task", input: { context, tasks } }, h.context);
	const spawn = async (h: Harness, name: string) =>
		((await h.handlers.before_subagent_spawn({ ...baseEvent, modelRole: "task", spawnKey: name }, h.context)) as Routed)?.model;
	const spawnAll = (h: Harness, names: string[]) => Promise.all(names.map((name) => spawn(h, name)));
	const perQuestion = {
		model_tier_0: { choice: "heavy", confidence: 0.95 },
		model_tier_1: { choice: "medium", confidence: 0.9 },
		model_tier_2: { choice: "quick", confidence: 0.92 },
	};
	const named = (prefix: string) => [`${prefix}1`, `${prefix}2`, `${prefix}3`];

	// 1. three concurrent spawns of one task call: one request, one answer each
	const okNames = named("BatchOk");
	const ok = harness({ perQuestion });
	send(ok, okNames.map((n) => item(n)));
	assert.deepEqual(await spawnAll(ok, okNames), ["@slow", "@default", "@smol"]);
	assert.equal(ok.calls.length, 1, "one judgment for the whole task call");
	assert.deepEqual(Object.keys(ok.calls[0].questions), ["model_tier_0", "model_tier_1", "model_tier_2"]);
	assert.deepEqual((ok.calls[0].state.tasks as { name: string }[]).map((t) => t.name), okNames);
	assert.match(ok.calls[0].questions.model_tier_1.instructions, /`tasks\[1\]`/);
	assert.equal(ok.calls[0].purpose, "jev-tier:model_tier");

	// 2. a member held back by concurrency limits spawns later: still no second request
	const lateNames = named("BatchLate");
	const late = harness({ perQuestion });
	send(late, lateNames.map((n) => item(n)));
	assert.deepEqual(await spawnAll(late, lateNames.slice(0, 2)), ["@slow", "@default"]);
	assert.equal(await spawn(late, lateNames[2]), "@smol");
	assert.equal(late.calls.length, 1);

	// 3. judge failure: every member fails open, logged as today, one request
	const failNames = named("BatchFail");
	const failed = harness({ fail: true });
	send(failed, failNames.map((n) => item(n)));
	assert.deepEqual(await spawnAll(failed, failNames), [undefined, undefined, undefined]);
	assert.equal(failed.calls.length, 1);
	const failLines = readFileSync(logFile, "utf8").split("\n").filter((line) => line.includes("spawn=BatchFail"));
	assert.equal(failLines.length, 3);
	assert.ok(failLines.every((line) => line.includes('reason="jev error: forced judge failure"')));

	// 4. one unusable answer fails open for that spawn alone
	const omitNames = named("BatchOmit");
	const omitted = harness({ perQuestion, omit: ["model_tier_1"] });
	send(omitted, omitNames.map((n) => item(n)));
	assert.deepEqual(await spawnAll(omitted, omitNames), ["@slow", undefined, "@smol"]);

	// 5. an explicit model keeps that item out of the request
	const [a, b, c] = named("BatchExplicit");
	const explicit = harness({ perQuestion: { model_tier_0: perQuestion.model_tier_0, model_tier_1: perQuestion.model_tier_2 } });
	send(explicit, [item(a), item(b, { model: "@smol" }), item(c)]);
	assert.deepEqual(await spawnAll(explicit, [a, b, c]), ["@slow", undefined, "@smol"]);
	assert.equal(explicit.calls.length, 1);
	assert.deepEqual(Object.keys(explicit.calls[0].questions), ["model_tier_0", "model_tier_1"]);
	assert.deepEqual((explicit.calls[0].state.tasks as { name: string }[]).map((t) => t.name), [a, c]);

	// 6. a big batch gets a longer budget: Jev answers after 3.3s, past the 3s base
	const slowNames = named("BatchSlow");
	const slow = harness({ choice: "medium", confidence: 0.9, delayMs: 3300 });
	send(slow, slowNames.map((n) => item(n, { task: "Refactor the importer. ".repeat(55) })), "Shared background. ".repeat(32));
	assert.deepEqual(await spawnAll(slow, slowNames), ["@default", "@default", "@default"]);
	assert.equal(slow.calls.length, 1);
	console.log("PASS batch: one judgment per task call, per-spawn answers, late member, failure and unusable answer fail open, explicit model excluded, scaled budget");
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

interface Harness {
	handlers: Record<string, Handler>;
	calls: JudgeRequest[];
	notices: string[];
	context: ExtensionContext;
}

function harness(scenario: Scenario = {}): Harness {
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
	assert.equal((await sendMessage(planText, { choice: "plan", confidence: 0.59 })).result, undefined);
	assert.equal((await sendMessage(planText, { choice: "plan", confidence: 0.6 })).result?.text, `/plan ${planText}`, "plan verdict at 0.6 switches");
	// the exact message from the log (plan 0.54 was skipped at 0.75) now switches without asking Jev
	const logged = "Please make a plan to fix the rejected creative logic as mentioned before";
	const asked = await sendMessage(logged, { choice: "direct", confidence: 0.99 });
	assert.equal(asked.result?.text, `/plan ${logged}`);
	assert.equal(asked.calls.length, 0, "an explicit request never calls Jev");
	assert.deepEqual(asked.notices, ["Plan mode: you asked for a plan"]);
	// explicit-request gates: opt-out and magic keywords still win, and a negated request is not a request
	for (const text of ["Please make a plan to fix it, don't plan too much", "Write a plan for the migration, just do it", "orchestrate this: make a plan for the migration"]) {
		const r = await sendMessage(text, { choice: "direct", confidence: 0.99 });
		assert.equal(r.result, undefined, text);
	}
	const refused = await sendMessage("Don't plan this, fix the typo in src/a.ts", { choice: "plan", confidence: 0.99 });
	assert.equal(refused.result, undefined, "explicit don't-plan skips");
	assert.equal(refused.calls.length, 0);
	// a long pasted spec: Jev answers after 3.3s, past the 3s short-message budget but inside the scaled one
	const spec = `Build a retry subsystem.\n${"The importer must be idempotent and report progress per batch. ".repeat(60)}`;
	const longSpec = await sendMessage(spec, { choice: "plan", confidence: 0.9, delayMs: 3300 });
	assert.equal(longSpec.result?.text, `/plan ${spec.trim()}`, "long message must not time out at 3s");
	assert.equal(longSpec.calls.length, 1);
	assert.equal((longSpec.calls[0].state.message as string).length, 2000);
	assert.equal(planTimeoutMs(3000, 100), 3000);
	assert.equal(planTimeoutMs(3000, 500), 3000);
	assert.equal(planTimeoutMs(3000, 1250), 5500);
	assert.equal(planTimeoutMs(3000, 2000), 8000);
	assert.equal(planTimeoutMs(3000, 50_000), 8000);
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

function runExplicitPlanChecks(): void {
	for (const text of [
		"Please make a plan to fix the rejected creative logic",
		"write me a detailed plan for the cache",
		"Create a plan",
		"let's plan",
		"Let's plan the rollout",
		"can you plan this out",
		"plan this first",
		"plan out the migration",
		"plan first, then implement",
	]) {
		assert.equal(explicitPlanRequest(text), true, text);
	}
	for (const text of [
		"Don't make a plan",
		"there's no need to write a plan",
		"I plan this week to ship it",
		"we plan to refactor later",
		"update plan.md",
		"create a plan.md file",
		"what does the plan look like?",
		"```\nmake a plan\n```",
		"read `make a plan` in the docs",
		"make a planner",
	]) {
		assert.equal(explicitPlanRequest(text), false, text);
	}
	assert.equal(explicitPlanRequest("make a plan"), true, "matcher must be stateless between calls");
	assert.equal(explicitPlanRequest("make a plan"), true);
	console.log("PASS explicit plan: phrases, negation, code spans, false positives");
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
await runTimeoutScalingChecks();
await runBatchChecks();
runKeywordChecks();
runExplicitPlanChecks();
await runPlanChecks();
await runSingleCallChecks();
console.log(`\n--- plan log lines from this run (${logFile}) ---`);
console.log(readFileSync(logFile, "utf8").trimEnd());
