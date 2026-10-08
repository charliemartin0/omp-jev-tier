import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DEFAULT_CONFIG, TIMEOUT_CAP_MS, TaskIndex, askChoice, decide, explicitReason, formatLog, isOff, isPlanOff, parseConfig, spawnTimeoutMs, type JudgeFn, type JudgeRequest, type SpawnEvent } from "./core";
import { explicitPlanRequest, findMagicKeyword, planTimeoutMs } from "./plan";
import { register, type ExtensionContext } from "./register";

const config = parseConfig(undefined);
const testRoot = mkdtempSync(join(tmpdir(), "jev-tier-test-"));
const envKeys = ["JEV_TIER", "JEV_PLAN", "JEV_TIER_CONFIG"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const currentModel = "anthropic/claude-sonnet-5-5";
const baseEvent: SpawnEvent = { agent: "task", invocationKind: "task", patterns: [`${currentModel}:high`], spawnKey: "sample" };
const when = new Date("2026-10-06T00:00:00.000Z");

// A scripted stand-in for omp's native judge. It enforces what the native cache and `judge()` normalizer need
// (string instructions, string criteria, choice questions) and records every call.
interface Script {
	choice?: string;
	confidence?: number;
	fail?: boolean;
	errorMessage?: string;
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
		if (script.fail) throw new Error(script.errorMessage ?? "forced judge failure");
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

	const secret = await decide({ event: baseEvent, pending: pending("Summarize API_KEY=secret-value-1234567890 and auth config"), currentModel, config, judge: scripted({ choice: "quick" }).judge });
	assert.ok(!formatLog(secret, baseEvent, when, true).includes("secret-value-1234567890"), "text opt-in must still redact credentials");
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
	const failLines = readFileSync(failed.logFile, "utf8").split("\n").filter((line) => line.includes('spawn="BatchFail'));
	assert.equal(failLines.length, 3);
	assert.ok(failLines.every((line) => line.includes('reason="jev error"')), "metadata mode must not persist judge error details");

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
	planAvailable?: boolean;
	config?: unknown;
	/** Undefined creates a valid empty config; useDefaultConfig leaves the natural default missing. */
	useDefaultConfig?: boolean;
	configPath?: string;
	useDefaultLog?: boolean;
	logPath?: string;
	judgeFn?: JudgeFn;
}

type Handler = (event: unknown, context: ExtensionContext) => unknown;

interface Harness {
	handlers: Record<string, Handler>;
	calls: JudgeRequest[];
	notices: string[];
	context: ExtensionContext;
	root: string;
	agentDir: string;
	configPath: string;
	logFile: string;
}

function harness(scenario: Scenario = {}): Harness {
	const root = mkdtempSync(join(testRoot, "fixture-"));
	const agentDir = join(root, "agent");
	const selectedPath = scenario.configPath ?? (scenario.useDefaultConfig
		? join(agentDir, "extensions", "jev-tier", "config.json")
		: join(root, "selected", "config.json"));
	const configPath = resolve(selectedPath.startsWith("~/") ? join(homedir(), selectedPath.slice(2)) : selectedPath);
	if (scenario.config !== undefined || !scenario.useDefaultConfig) {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, JSON.stringify(scenario.config ?? {}));
	}
	const logFile = resolve(scenario.logPath ?? (scenario.useDefaultLog ? join(agentDir, "logs", "jev-tier.log") : join(root, "logs", "fixture.log")));
	const handlers: Record<string, Handler> = {};
	const { judge, calls } = scripted(scenario);
	register(
		{ on: (event, handler) => void (handlers[event] = handler) },
		{
			agentDir,
			configPath: scenario.useDefaultConfig ? undefined : selectedPath,
			planModeAvailable: () => scenario.planAvailable ?? true,
			magicKeywordActive: () => scenario.magicActive ?? true,
			judge: (_context, request) => scenario.judgeFn ? scenario.judgeFn(request) : judge(request),
			logPath: scenario.useDefaultLog ? undefined : scenario.logPath ?? logFile,
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
	return { handlers, calls, notices, context, root, agentDir, configPath, logFile };
}

async function sendMessage(text: string, scenario: Scenario = {}) {
	const { handlers, calls, notices, context, logFile } = harness(scenario);
	const result = (await handlers.input({ text, source: "interactive" }, context)) as { text?: string } | undefined;
	return { result, calls, notices, logFile };
}

async function runPlanChecks(): Promise<void> {

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

	const log = readFileSync(plan.logFile, "utf8");
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

// ---------------------------------------------------------------- configuration and live hooks

type Routed = { model: string; note?: string } | undefined;
type Rewritten = { text: string } | undefined;
const featureText = "Add retry handling across src/api/sync.ts and src/worker/sync.ts";
const configWarning = "jev-tier: cannot read configuration; routing disabled until fixed";

function rewriteConfig(h: Harness, value: unknown): void {
	mkdirSync(dirname(h.configPath), { recursive: true });
	writeFileSync(h.configPath, JSON.stringify(value));
}

async function route(h: Harness, name = "ConfiguredTask", task = "Summarize src/a.ts"): Promise<Routed> {
	h.handlers.tool_call({ toolName: "task", input: { tasks: [{ name, agent: "task", task }] } }, h.context);
	return await h.handlers.before_subagent_spawn({ ...baseEvent, modelRole: "task", spawnKey: name }, h.context) as Routed;
}

async function message(h: Harness, text = featureText): Promise<Rewritten> {
	return await h.handlers.input({ text, source: "interactive" }, h.context) as Rewritten;
}

async function withEnv(values: Partial<Record<typeof envKeys[number], string>>, run: () => Promise<void>): Promise<void> {
	const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	try {
		for (const key of envKeys) {
			if (values[key] === undefined) delete process.env[key];
			else process.env[key] = values[key];
		}
		await run();
	} finally {
		for (const key of envKeys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
}

async function runConfigurationChecks(): Promise<void> {
	assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
	for (const raw of [null, false, "invalid", [], [{ enabled: false }]]) assert.deepEqual(parseConfig(raw), DEFAULT_CONFIG);
	const partial = parseConfig({ tierModels: { quick: "  @default  ", ignored: "@unused" }, logging: { includeText: true, ignored: true }, unknown: true });
	assert.deepEqual(partial.tierModels, { heavy: "@slow", medium: "@default", quick: "@default" });
	assert.deepEqual(partial.logging, { enabled: true, includeText: true });
	assert.ok(!("unknown" in partial));
	const first = parseConfig(undefined);
	const second = parseConfig(undefined);
	first.tierModels.quick = "test/mutated";
	first.logging.enabled = false;
	first.logging.path = "mutated.log";
	assert.deepEqual(second, DEFAULT_CONFIG, "each parse owns fresh nested defaults");
	assert.equal(DEFAULT_CONFIG.tierModels.quick, "@smol");
	assert.deepEqual(DEFAULT_CONFIG.logging, { enabled: true, includeText: false });
	for (const invalid of [undefined, null, false, [], { heavy: "", medium: 42, quick: "   " }]) {
		assert.deepEqual(parseConfig({ tierModels: invalid }).tierModels, DEFAULT_CONFIG.tierModels);
	}
	for (const invalid of [null, false, [], { enabled: "false", includeText: 1, path: " " }]) {
		assert.deepEqual(parseConfig({ logging: invalid }).logging, DEFAULT_CONFIG.logging);
	}
	assert.deepEqual(parseConfig({ logging: { enabled: false, path: "  logs/custom.log  " } }).logging, { enabled: false, includeText: false, path: "logs/custom.log" });
	for (const invalid of [NaN, Infinity, -Infinity, 0, -1, "120"]) {
		const parsed = parseConfig({ timeoutMs: invalid, planTimeoutMs: invalid });
		assert.equal(parsed.timeoutMs, 3000);
		assert.equal(parsed.planTimeoutMs, 3000);
	}
	for (const invalid of [NaN, Infinity, -Infinity, -0.1, 1.1, "0.5"]) {
		const parsed = parseConfig({ minConfidence: invalid, planMinConfidence: invalid });
		assert.equal(parsed.minConfidence, 0.7);
		assert.equal(parsed.planMinConfidence, 0.6);
	}
	assert.equal(parseConfig({ timeoutMs: 80 }).planTimeoutMs, 80, "omitted plan base preserves the smaller legacy timeout");
	assert.equal(parseConfig({ timeoutMs: 6000 }).planTimeoutMs, 3000);
	assert.equal(parseConfig({ timeoutMs: 80, planTimeoutMs: "bad" }).planTimeoutMs, 80);
	assert.equal(parseConfig({ timeoutMs: 20_000, planTimeoutMs: 20_000 }).planTimeoutMs, TIMEOUT_CAP_MS);
	for (const threshold of [0, 1]) {
		const parsed = parseConfig({ minConfidence: threshold, planMinConfidence: threshold });
		assert.equal(parsed.minConfidence, threshold);
		assert.equal(parsed.planMinConfidence, threshold);
	}
	assert.deepEqual(
		parseConfig({ enabled: "false", tierEnabled: 0, planEnabled: null }),
		DEFAULT_CONFIG,
		"wrong-type toggles do not override defaults",
	);

	const quick = harness({ choice: "quick", config: { tierModels: { quick: "@default" } } });
	assert.equal((await route(quick))?.model, "@default", "a named, unpinned quick spawn returns the configured selector");
	const heavy = harness({ choice: "heavy", config: { tierModels: { quick: "@default" } } });
	assert.equal((await route(heavy))?.model, "@slow", "partial overrides retain other tier defaults");
	const selectors = { heavy: "test/heavy", medium: "@smol", quick: "test/quick" };
	for (const tier of ["heavy", "medium", "quick"] as const) {
		const h = harness({ choice: tier, config: { tierModels: selectors } });
		assert.equal((await route(h))?.model, selectors[tier]);
		assert.equal(h.calls.length, 1);
	}
	const batch = harness({
		config: { tierModels: selectors },
		perQuestion: {
			model_tier_0: { choice: "heavy", confidence: 0.9 },
			model_tier_1: { choice: "medium", confidence: 0.9 },
			model_tier_2: { choice: "quick", confidence: 0.9 },
		},
	});
	const names = ["CustomHeavy", "CustomMedium", "CustomQuick"];
	batch.handlers.tool_call({ toolName: "task", input: { tasks: names.map((name) => ({ name, task: `Summarize src/${name}.ts` })) } }, batch.context);
	const routed = await Promise.all(names.map(async (spawnKey) => await batch.handlers.before_subagent_spawn({ ...baseEvent, modelRole: "task", spawnKey }, batch.context) as Routed));
	assert.deepEqual(routed.map((result) => result?.model), [selectors.heavy, selectors.medium, selectors.quick]);
	assert.equal(batch.calls.length, 1, "custom selectors preserve the single batched judgment");
	const invalid = harness({ choice: "quick", config: { tierModels: { quick: "", heavy: false }, logging: [] } });
	assert.equal((await route(invalid))?.model, "@smol");

	for (const confidence of [0.799, 0.8]) {
		const tier = harness({ choice: "quick", confidence, config: { minConfidence: 0.8 } });
		assert.equal((await route(tier))?.model, confidence < 0.8 ? undefined : "@smol", "custom tier confidence applies at the boundary");
		const plan = harness({ choice: "plan", confidence, config: { planMinConfidence: 0.8 } });
		assert.equal((await message(plan))?.text, confidence < 0.8 ? undefined : `/plan ${featureText}`, "custom plan confidence switches at the boundary");
	}
	console.log("PASS configuration: validation, fresh defaults, custom single/batch selectors, custom confidence boundaries");
}

async function runFeatureGateChecks(): Promise<void> {
	const planOnly = harness({ config: { tierEnabled: false, planEnabled: true }, choice: "plan" });
	assert.equal(await route(planOnly), undefined);
	assert.equal(planOnly.calls.length, 0);
	assert.equal((await message(planOnly))?.text, `/plan ${featureText}`);
	assert.equal(planOnly.calls.length, 1);
	const tierOnly = harness({ config: { tierEnabled: true, planEnabled: false }, choice: "quick" });
	assert.equal(await message(tierOnly), undefined);
	assert.equal(tierOnly.calls.length, 0);
	assert.equal((await route(tierOnly))?.model, "@smol");
	const masterOff = harness({ config: { enabled: false }, choice: "quick" });
	assert.equal(await route(masterOff), undefined);
	assert.equal(await message(masterOff), undefined);
	assert.equal(masterOff.calls.length, 0);
	const hostOff = await sendMessage(featureText, { planAvailable: false, choice: "plan" });
	assert.equal(hostOff.result, undefined);
	assert.equal(hostOff.calls.length, 0);
	for (const synonym of ["off", "0", "false", "no", "disabled", "disable", " OFF "]) {
		await withEnv({ JEV_TIER: synonym, JEV_PLAN: "on" }, async () => {
			const h = harness({ choice: "quick" });
			assert.equal(await route(h), undefined);
			assert.equal(await message(h), undefined);
			assert.equal(h.calls.length, 0, `master env disable wins: ${synonym}`);
		});
		await withEnv({ JEV_PLAN: synonym }, async () => {
			const h = harness({ choice: "quick" });
			assert.equal(await message(h), undefined);
			assert.equal((await route(h))?.model, "@smol", `plan-only env disable preserves tiering: ${synonym}`);
			assert.equal(h.calls.length, 1);
		});
	}
	assert.equal(isOff({ JEV_TIER: "on" }, parseConfig({ enabled: false })), true, "env is disable-only");
	assert.equal(isPlanOff({ JEV_PLAN: "on" }, parseConfig({ planEnabled: false })), true);
	await withEnv({ JEV_TIER: "on", JEV_PLAN: "on" }, async () => {
		const h = harness({ config: { enabled: false }, choice: "quick" });
		assert.equal(await route(h), undefined);
		assert.equal(await message(h), undefined);
		assert.equal(h.calls.length, 0);
	});
	console.log("PASS gates: independent features, master switch, host plan gate, environment disable-only precedence");
}

async function runConfiguredTimeoutChecks(): Promise<void> {
	const h = harness({
		config: { timeoutMs: 250, planTimeoutMs: 25 },
		delayMs: 100,
		perQuestion: { plan_route: { choice: "plan", confidence: 0.9 }, model_tier: { choice: "quick", confidence: 0.9 } },
	});
	const start = Date.now();
	assert.equal(await message(h), undefined, "small explicit plan base fails open even when the judge ignores abort");
	assert.ok(Date.now() - start < 1000);
	assert.equal(h.calls[0].signal.aborted, true, "the timed-out plan request is aborted");
	assert.equal((await route(h))?.model, "@smol", "the plan base must not shorten the spawn base");
	assert.equal(h.calls[1].signal.aborted, false);
	assert.deepEqual(h.notices, []);
	const hungCalls: JudgeRequest[] = [];
	const hung = harness({
		config: { timeoutMs: 30, planTimeoutMs: 15 },
		judgeFn: (request) => {
			hungCalls.push(request);
			return Promise.withResolvers<never>().promise;
		},
	});
	assert.equal(await message(hung), undefined);
	assert.equal(await route(hung), undefined);
	assert.equal(hungCalls.length, 2);
	assert.ok(hungCalls.every((request) => request.signal.aborted), "both configured waits settle and abort an uncooperative judge");
	const legacy = harness({ config: { timeoutMs: 20 }, choice: "plan", delayMs: 60 });
	assert.equal(await message(legacy), undefined, "omitted plan base uses the parsed smaller spawn base");
	assert.equal(legacy.calls[0].signal.aborted, true);
	const capped = parseConfig({ timeoutMs: 50_000, planTimeoutMs: 50_000 });
	assert.equal(spawnTimeoutMs(capped.timeoutMs, 50_000), TIMEOUT_CAP_MS);
	assert.equal(planTimeoutMs(capped.planTimeoutMs, 50_000), TIMEOUT_CAP_MS);
	const cappedRequests: JudgeRequest[] = [];
	const cappedHooks = harness({
		config: { timeoutMs: 50_000, planTimeoutMs: 50_000, logging: { includeText: true } },
		judgeFn: (request) => {
			cappedRequests.push(request);
			return Promise.withResolvers<never>().promise;
		},
	});
	const capStart = Date.now();
	assert.deepEqual(await Promise.all([message(cappedHooks), route(cappedHooks)]), [undefined, undefined], "both oversized bases fail open at the hard cap");
	assert.ok(Date.now() - capStart < 11_000, "neither configured base can wait for the requested 50 seconds");
	assert.equal(cappedRequests.length, 2);
	assert.ok(cappedRequests.every((request) => request.signal.aborted));
	const cappedLog = readFileSync(cappedHooks.logFile, "utf8");
	assert.equal(cappedLog.split("timeout after 8000ms").length - 1, 2, "both actual hooks enforce the fixed 8-second cap");
	console.log("PASS configured timeouts: independent bases, abort-ignoring fail-open, legacy fallback, capped scaling");
}

async function runPrivacyChecks(): Promise<void> {
	const distinctive = "distinctive private task wording";
	const metadata = harness({
		perQuestion: { model_tier: { choice: "quick", confidence: 0.9 }, plan_route: { choice: "plan", confidence: 0.9 } },
	});
	assert.equal((await route(metadata, "MetadataTask", distinctive))?.model, "@smol");
	assert.equal((await message(metadata, `${distinctive} across src/a.ts and src/b.ts`))?.text?.startsWith("/plan "), true);
	const lines = readFileSync(metadata.logFile, "utf8");
	assert.match(lines, /tier=quick/);
	assert.match(lines, /verdict=plan/);
	assert.match(lines, /action=applied/);
	assert.match(lines, /action=switched/);
	assert.doesNotMatch(lines, /(?:task|msg)=/);
	assert.ok(!lines.includes(distinctive));
	assert.equal(statSync(metadata.logFile).mode & 0o777, 0o600, "new logs are private");
	const error = harness({ fail: true, errorMessage: `service echoed ${distinctive} API_KEY=secret-value-1234567890` });
	await route(error, "ErrorTask", distinctive);
	await message(error, distinctive);
	const errorLog = readFileSync(error.logFile, "utf8");
	assert.equal(errorLog.split('reason="jev error"').length - 1, 2);
	assert.ok(!errorLog.includes(distinctive));
	assert.ok(!errorLog.includes("secret-value-1234567890"));
	assert.doesNotMatch(errorLog, /(?:task|msg)=/);

	const optIn = harness({
		config: { logging: { includeText: true } },
		perQuestion: { model_tier: { choice: "quick", confidence: 0.9 }, plan_route: { choice: "plan", confidence: 0.9 } },
	});
	await route(optIn, "OptInTask", `${distinctive} API_KEY=secret-value-1234567890`);
	await message(optIn, `${distinctive} API_KEY=secret-value-1234567890 across src/a.ts and src/b.ts`);
	const textLog = readFileSync(optIn.logFile, "utf8");
	assert.match(textLog, /task=/);
	assert.match(textLog, /msg=/);
	assert.ok(textLog.includes(distinctive));
	assert.ok(textLog.includes("[redacted]"));
	assert.ok(!textLog.includes("secret-value-1234567890"));
	const detailedError = harness({
		fail: true,
		errorMessage: `service echoed ${distinctive} API_KEY=secret-value-1234567890`,
		config: { logging: { includeText: true } },
	});
	await route(detailedError, "DetailedError", distinctive);
	await message(detailedError, distinctive);
	const details = readFileSync(detailedError.logFile, "utf8");
	assert.ok(details.includes(`jev error: service echoed ${distinctive}`));
	assert.ok(details.includes("[redacted]"));
	assert.ok(!details.includes("secret-value-1234567890"));

	const off = harness({
		useDefaultLog: true,
		config: { tierModels: { quick: "@default" }, logging: { enabled: false } },
		perQuestion: { model_tier: { choice: "quick", confidence: 0.9 }, plan_route: { choice: "plan", confidence: 0.9 } },
	});
	assert.equal((await route(off))?.model, "@default");
	assert.equal((await message(off))?.text, `/plan ${featureText}`);
	assert.equal(existsSync(off.logFile), false);
	assert.equal(existsSync(dirname(off.logFile)), false, "disabled logging creates no directory");
	const overrideOff = harness({ config: { logging: { enabled: false, path: "never-created/custom.log" } }, choice: "quick" });
	assert.equal((await route(overrideOff))?.model, "@smol");
	assert.equal(existsSync(dirname(overrideOff.logFile)), false, "disabled logging also suppresses dependency overrides");
	assert.equal(existsSync(join(dirname(overrideOff.configPath), "never-created")), false);

	const identifiers = harness({ choice: "quick", config: { tierModels: { quick: "test/model\ninjected" } } });
	identifiers.handlers.tool_call({ toolName: "task", input: { tasks: [{ name: "Quoted\nTask", task: "Summarize src/a.ts" }] } }, identifiers.context);
	await identifiers.handlers.before_subagent_spawn({ ...baseEvent, spawnKey: "Quoted\nTask", agent: "agent\ninjected" }, identifiers.context);
	const identifierLog = readFileSync(identifiers.logFile, "utf8");
	assert.equal(identifierLog.trimEnd().split("\n").length, 1, "free-text identifiers cannot inject log lines");
	assert.ok(identifierLog.includes(JSON.stringify("Quoted\nTask")));
	assert.ok(identifierLog.includes(JSON.stringify("agent\ninjected")));
	assert.ok(identifierLog.includes(JSON.stringify("test/model\ninjected")));

	const existing = harness({ choice: "quick" });
	mkdirSync(dirname(existing.logFile), { recursive: true });
	writeFileSync(existing.logFile, "existing\n", { mode: 0o644 });
	const priorMode = statSync(existing.logFile).mode & 0o777;
	await route(existing);
	assert.equal(statSync(existing.logFile).mode & 0o777, priorMode, "existing user log permissions are not changed");
	assert.ok(readFileSync(existing.logFile, "utf8").startsWith("existing\n"), "logging remains append-only");
	const brokenLog = harness({ choice: "quick" });
	mkdirSync(brokenLog.logFile, { recursive: true });
	assert.equal((await route(brokenLog))?.model, "@smol", "log write failures cannot break routing");
	console.log("PASS logging: metadata privacy, opt-in heuristic redaction, disabled side effects, private append, safe identifiers, fail-silent errors");
}

async function runConfigFileChecks(): Promise<void> {
	const missingDefault = harness({ choice: "quick", useDefaultConfig: true, useDefaultLog: true });
	assert.equal(existsSync(missingDefault.configPath), false);
	assert.equal((await route(missingDefault))?.model, "@smol");
	assert.deepEqual(missingDefault.notices, []);
	assert.equal(existsSync(missingDefault.configPath), false, "defaults never create the user's config");
	const failures = ["missing", "malformed", "unreadable", "array", "null", "primitive"] as const;
	for (const kind of failures) {
		const h = harness({
			perQuestion: { model_tier: { choice: "quick", confidence: 0.9 }, plan_route: { choice: "plan", confidence: 0.9 } },
		});
		if (kind === "missing") rmSync(h.configPath);
		else if (kind === "unreadable") {
			rmSync(h.configPath);
			mkdirSync(h.configPath); // deterministic EISDIR even when the suite is run as root
		} else writeFileSync(h.configPath, kind === "malformed" ? '{"credential":"never expose me"' : kind === "array" ? "[]" : kind === "null" ? "null" : '"primitive"');
		assert.equal(await route(h), undefined, kind);
		assert.equal(await message(h), undefined, kind);
		assert.equal(await route(h), undefined, kind);
		assert.equal(h.calls.length, 0, `${kind} configuration must not make a judge request`);
		assert.deepEqual(h.notices, [configWarning], "one sanitized warning for a failure period across hooks");
		assert.equal(existsSync(h.logFile), false);
		if (kind === "unreadable") rmSync(h.configPath, { recursive: true });
		rewriteConfig(h, { tierModels: { quick: "@default" } });
		assert.equal((await route(h))?.model, "@default", "valid rewrite recovers without re-registering");
		assert.equal((await message(h))?.text, `/plan ${featureText}`);
		assert.equal(h.calls.length, 2);
		writeFileSync(h.configPath, "{");
		assert.equal(await message(h), undefined);
		assert.equal(await route(h), undefined);
		assert.deepEqual(h.notices.filter((notice) => notice === configWarning), [configWarning, configWarning], "recovery resets warning suppression");
	}
	const live = harness({ choice: "quick" });
	assert.equal((await route(live))?.model, "@smol");
	rewriteConfig(live, { tierModels: { quick: "@default" } });
	assert.equal((await route(live))?.model, "@default", "partial config is reread on the next hook");
	rewriteConfig(live, { tierEnabled: false, planEnabled: true });
	assert.equal(await route(live), undefined);
	assert.equal((await message(live, "Make a plan to implement configurable routing"))?.text, "/plan Make a plan to implement configurable routing");
	rewriteConfig(live, { enabled: false });
	assert.equal(await message(live), undefined);
	rewriteConfig(live, { planEnabled: false });
	assert.equal((await route(live))?.model, "@smol");
	assert.equal(await message(live), undefined);
	const defaultRecovery = harness({ useDefaultConfig: true, choice: "quick", config: {} });
	writeFileSync(defaultRecovery.configPath, "{");
	assert.equal(await route(defaultRecovery), undefined);
	rmSync(defaultRecovery.configPath);
	assert.equal((await route(defaultRecovery))?.model, "@smol", "a missing default config ends the failure period");
	rewriteConfig(defaultRecovery, []);
	assert.equal(await route(defaultRecovery), undefined);
	assert.deepEqual(defaultRecovery.notices, [configWarning, configWarning]);
	const notifyFailure = harness({ choice: "quick" });
	rmSync(notifyFailure.configPath);
	let noticeAttempts = 0;
	notifyFailure.context.ui = { notify: () => { noticeAttempts++; throw new Error("UI failed"); } };
	assert.equal(await route(notifyFailure), undefined);
	assert.equal(await message(notifyFailure), undefined);
	assert.equal(noticeAttempts, 1, "notification errors are caught and suppressed for the failure period");
	rewriteConfig(notifyFailure, {});
	assert.equal((await route(notifyFailure))?.model, "@smol");
	console.log("PASS configuration files: default absence, explicit/read/JSON/root failures, sanitized warning periods, reload recovery");
}

async function runPathChecks(): Promise<void> {
	const first = harness({ useDefaultConfig: true, useDefaultLog: true, choice: "quick", config: { tierModels: { quick: "test/profile-one" } } });
	const second = harness({ useDefaultConfig: true, useDefaultLog: true, choice: "quick", config: { tierModels: { quick: "test/profile-two" } } });
	assert.equal((await route(first, "SharedName"))?.model, "test/profile-one");
	assert.equal((await route(second, "SharedName"))?.model, "test/profile-two");
	assert.ok(existsSync(join(first.agentDir, "logs", "jev-tier.log")));
	assert.ok(existsSync(join(second.agentDir, "logs", "jev-tier.log")));
	assert.equal(first.calls.length, 1);
	assert.equal(second.calls.length, 1, "registrations own their task capture state");
	const untouched = harness({ useDefaultConfig: true, choice: "quick" });
	assert.equal(await untouched.handlers.before_subagent_spawn({ ...baseEvent, spawnKey: "SharedName" }, untouched.context), undefined, "another registration's captured tasks are not visible");
	assert.equal(untouched.calls.length, 0);

	const selected = join(testRoot, "environment", "selected.json");
	mkdirSync(dirname(selected), { recursive: true });
	writeFileSync(selected, JSON.stringify({ tierModels: { quick: "test/environment" } }));
	await withEnv({ JEV_TIER_CONFIG: `  ${relative(process.cwd(), selected)}  ` }, async () => {
		const env = harness({ useDefaultConfig: true, choice: "quick", config: { enabled: false } });
		assert.equal((await route(env))?.model, "test/environment", "relative env override beats the profile file and resolves against startup cwd");
		process.env.JEV_TIER_CONFIG = join(testRoot, "changed-after-startup.json");
		assert.equal((await route(env))?.model, "test/environment", "config selection is resolved once per register instance");
		const explicit = harness({ choice: "quick", config: { tierModels: { quick: "test/dependency" } } });
		assert.equal((await route(explicit))?.model, "test/dependency", "dependency config selection beats the env override");
		const missingEnv = harness({ useDefaultConfig: true, choice: "quick" });
		assert.equal(await route(missingEnv), undefined, "missing explicitly selected env config fails closed");
		assert.deepEqual(missingEnv.notices, [configWarning]);
	});
	await withEnv({ JEV_TIER_CONFIG: "   " }, async () => {
		const blank = harness({ useDefaultConfig: true, choice: "quick" });
		assert.equal((await route(blank))?.model, "@smol", "blank env selection retains the missing-default behavior");
	});
	const relativeFile = join(testRoot, "relative-dependency", "config.json");
	const relativeConfig = harness({ choice: "quick", configPath: relative(process.cwd(), relativeFile), config: { tierModels: { quick: "test/relative" } } });
	assert.equal((await route(relativeConfig))?.model, "test/relative", "relative dependency config resolves against startup cwd");
	const tildeFile = join(testRoot, "tilde-dependency", "config.json");
	const tildeSelector = `~/${relative(homedir(), tildeFile)}`;
	const tildeConfig = harness({ choice: "quick", configPath: tildeSelector, config: { tierModels: { quick: "test/tilde" } } });
	assert.equal((await route(tildeConfig))?.model, "test/tilde", "leading tilde config selection is expanded without shell evaluation");
	const custom = harness({ useDefaultLog: true, choice: "quick", config: { logging: { path: "nested/custom.log" } } });
	assert.equal((await route(custom))?.model, "@smol");
	const firstLog = join(dirname(custom.configPath), "nested", "custom.log");
	assert.ok(existsSync(firstLog), "configured relative logfile is rooted at the selected config directory");
	assert.equal(existsSync(custom.logFile), false);
	rewriteConfig(custom, { tierModels: { quick: "@default" }, logging: { path: "other/live.log", includeText: true } });
	assert.equal((await route(custom, "LiveLog", "ordinary excerpt text"))?.model, "@default");
	const secondLog = join(dirname(custom.configPath), "other", "live.log");
	assert.match(readFileSync(secondLog, "utf8"), /task="ordinary excerpt text"/);
	rewriteConfig(custom, { logging: { enabled: false, path: "disabled/no.log" } });
	assert.equal((await route(custom))?.model, "@smol");
	assert.equal(existsSync(join(dirname(custom.configPath), "disabled")), false);
	const precedence = harness({ choice: "quick", config: { logging: { path: "ignored/custom.log" } } });
	await route(precedence);
	assert.ok(existsSync(precedence.logFile), "dependency logfile beats configured logfile");
	assert.equal(existsSync(join(dirname(precedence.configPath), "ignored")), false);
	const tildeLogFile = join(testRoot, "tilde-log", "custom.log");
	const tildeLog = harness({ useDefaultLog: true, choice: "quick", config: { logging: { path: `~/${relative(homedir(), tildeLogFile)}` } } });
	assert.equal((await route(tildeLog))?.model, "@smol");
	assert.ok(existsSync(tildeLogFile));
	const depLogFile = join(testRoot, "relative-log", "custom.log");
	const depLog = harness({ choice: "quick", logPath: relative(process.cwd(), depLogFile) });
	assert.equal((await route(depLog))?.model, "@smol");
	assert.ok(existsSync(depLogFile), "relative dependency logfile resolves against startup cwd");
	console.log("PASS paths: isolated profiles, dependency/env/default config precedence, startup cwd, tilde, log precedence and live settings");
}

try {
	for (const key of envKeys) delete process.env[key];
	await runTierChecks();
	await runPinChecks();
	await runTimeoutCheck();
	await runTimeoutScalingChecks();
	await runBatchChecks();
	runKeywordChecks();
	runExplicitPlanChecks();
	await runPlanChecks();
	await runSingleCallChecks();
	await runConfigurationChecks();
	await runFeatureGateChecks();
	await runConfiguredTimeoutChecks();
	await runPrivacyChecks();
	await runConfigFileChecks();
	await runPathChecks();
	console.log("PASS all executable harness checks");
} finally {
	for (const key of envKeys) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	rmSync(testRoot, { recursive: true, force: true });
}
