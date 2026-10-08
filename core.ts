// Pure decision logic for the jev-tier extension. No omp imports, so it can be driven by tests.

export type Tier = "heavy" | "medium" | "quick";

export const TIERS: readonly Tier[] = ["heavy", "medium", "quick"];

// heavy = slow role, medium = default role, quick = smol role. Role aliases resolve through the
// user's own modelRoles and fallback chains; nothing here names a concrete model.
export const TIER_MODEL: Record<Tier, string> = {
	heavy: "@slow",
	medium: "@default",
	quick: "@smol",
};


export interface Config {
	enabled: boolean;
	timeoutMs: number;
	minConfidence: number;
	/** Automatic plan-mode detection (JEV_PLAN / `planEnabled`). */
	planEnabled: boolean;
	planMinConfidence: number;
}

export const DEFAULT_CONFIG: Config = { enabled: true, timeoutMs: 3000, minConfidence: 0.7, planEnabled: true, planMinConfidence: 0.6 };

/** Hard cap on any Jev wait: config and length scaling both stop here. */
export const TIMEOUT_CAP_MS = 8000;

// The base timeout up to `fromChars` of text sent, rising linearly to the 8s cap at `toChars`.
export function scaledTimeoutMs(baseMs: number, chars: number, fromChars: number, toChars: number): number {
	const fraction = Math.min(1, Math.max(0, (chars - fromChars) / (toChars - fromChars)));
	return Math.max(baseMs, Math.round(baseMs + (TIMEOUT_CAP_MS - baseMs) * fraction));
}

const SPAWN_SCALE_FROM_CHARS = 1000;
const SPAWN_SCALE_TO_CHARS = 8000;

// Spawn tiering: the base timeout up to 1000 characters of serialized Jev state, 8s from 8000 characters
// (a single task state is ~2-3k characters, a three-task batch ~6-7k).
export function spawnTimeoutMs(baseMs: number, chars: number): number {
	return scaledTimeoutMs(baseMs, chars, SPAWN_SCALE_FROM_CHARS, SPAWN_SCALE_TO_CHARS);
}

export interface TaskItem {
	name?: string;
	agent?: string;
	task?: string;
	model?: unknown;
	solutionSpace?: string;
	[key: string]: unknown;
}

export interface PendingTask {
	name: string;
	item: TaskItem;
	context: string;
	at: number;
	consumed: boolean;
	/** The `task` tool call this item came from; spawns of one call share one Jev request. */
	batch?: TaskBatch;
}

export type TierVerdicts = Map<PendingTask, ChoiceAnswer<Tier> | undefined>;

/** The named items captured from one `task` tool call. */
export interface TaskBatch {
	context: string;
	members: PendingTask[];
	/** Started by the first member spawn that needs Jev; every later member spawn reads its answer from it. */
	verdicts?: Promise<TierVerdicts>;
}

export interface SpawnEvent {
	agent?: string;
	invocationKind?: string;
	modelRole?: string;
	patterns?: string[];
	spawnKey?: string;
}

/** The shape omp's judge accepts: string instructions and string criteria (its cache and `judge()` helper require strings). */
export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export interface JudgeRequest {
	state: Record<string, unknown>;
	questions: Record<string, ChoiceQuestion>;
	purpose: string;
	signal: AbortSignal;
}

/** Runs one judgment through omp's native judge and returns its raw `{ answers }` response. Throws on any failure. */
export type JudgeFn = (request: JudgeRequest) => Promise<unknown>;

/** One criteria label: what it covers, a few examples, and what it is not. */
export function rubric(covers: string, examples: readonly string[], not: string): string {
	return `${covers} Examples: ${examples.join("; ")}. Not: ${not}`;
}

export interface Signals {
	runs_tests: boolean;
	migrations: boolean;
	concurrency: boolean;
	security: boolean;
	cross_layer: boolean;
}

export type Decision =
	| { action: "apply"; tier: Tier; confidence: number; model: string; note: string; reason: string; summary: string }
	| { action: "skip"; reason: string; summary: string; tier?: Tier; confidence?: number };

// ---------------------------------------------------------------- config / toggle

const OFF: Record<string, true> = { off: true, "0": true, false: true, no: true, disabled: true, disable: true };

export function isOff(env: Record<string, string | undefined>, config: Config): boolean {
	const v = env.JEV_TIER?.trim().toLowerCase();
	if (v !== undefined && OFF[v] === true) return true;
	return config.enabled === false;
}

export function parseConfig(raw: unknown): Config {
	const out = { ...DEFAULT_CONFIG };
	if (!raw || typeof raw !== "object") return out;
	const r = raw as Record<string, unknown>;
	if (typeof r.enabled === "boolean") out.enabled = r.enabled;
	if (typeof r.timeoutMs === "number" && r.timeoutMs > 0) out.timeoutMs = Math.min(r.timeoutMs, TIMEOUT_CAP_MS);
	if (typeof r.minConfidence === "number" && r.minConfidence >= 0 && r.minConfidence <= 1) out.minConfidence = r.minConfidence;
	if (typeof r.planEnabled === "boolean") out.planEnabled = r.planEnabled;
	if (typeof r.planMinConfidence === "number" && r.planMinConfidence >= 0 && r.planMinConfidence <= 1) out.planMinConfidence = r.planMinConfidence;
	return out;
}

// JEV_PLAN=off disables plan detection alone; JEV_TIER=off (isOff) still disables the whole extension.
export function isPlanOff(env: Record<string, string | undefined>, config: Config): boolean {
	const v = env.JEV_PLAN?.trim().toLowerCase();
	if (v !== undefined && OFF[v] === true) return true;
	return config.planEnabled === false;
}

// ---------------------------------------------------------------- task capture (tool_call -> spawn)

const MAX_PENDING = 256;
const PENDING_TTL_MS = 30 * 60_000;

export class TaskIndex {
	#entries: PendingTask[] = [];

	// The `task` tool input is either one flat item or `{ context, tasks: [...] }`. `tool_call` can fire
	// more than once per call, so entries are deduplicated by (name, task text).
	remember(input: unknown, now = Date.now()): void {
		if (!input || typeof input !== "object") return;
		const rec = input as Record<string, unknown>;
		const items = Array.isArray(rec.tasks) ? (rec.tasks as unknown[]) : [rec];
		const context = typeof rec.context === "string" ? rec.context : "";
		const members: PendingTask[] = [];
		for (const raw of items) {
			if (!raw || typeof raw !== "object") continue;
			const item = raw as TaskItem;
			const name = typeof item.name === "string" ? item.name.trim() : "";
			// Unnamed items get a random agent id at dispatch, so they cannot be correlated.
			if (!name) continue;
			const text = typeof item.task === "string" ? item.task : "";
			const existing = this.#entries.find((e) => e.name === name && (e.item.task ?? "") === text && !e.consumed);
			let entry: PendingTask;
			if (existing) {
				existing.item = item;
				existing.context = context;
				existing.at = now;
				entry = existing;
			} else {
				entry = { name, item, context, at: now, consumed: false };
				this.#entries.push(entry);
			}
			if (!members.includes(entry)) members.push(entry);
		}
		const batch: TaskBatch = { context, members };
		for (const member of members) member.batch = batch;
		this.#prune(now);
	}

	// spawnKey is the allocated agent id: the item name, `name-2` on collision, optionally `parent.` prefixed.
	take(spawnKey: string | undefined, now = Date.now()): PendingTask | undefined {
		if (!spawnKey) return undefined;
		this.#prune(now);
		const base = spawnKey.slice(spawnKey.lastIndexOf(".") + 1);
		const candidates = (name: string) => this.#entries.filter((e) => e.name === name);
		let pool = candidates(base);
		if (pool.length === 0) {
			const m = /^(.*)-\d+$/.exec(base);
			if (m) pool = candidates(m[1]);
		}
		if (pool.length === 0) return undefined;
		const fresh = pool.filter((e) => !e.consumed);
		const pick = (fresh.length > 0 ? fresh : pool).reduce((a, b) => (b.at >= a.at ? b : a));
		pick.consumed = true;
		return pick;
	}

	#prune(now: number): void {
		this.#entries = this.#entries.filter((e) => now - e.at <= PENDING_TTL_MS);
		if (this.#entries.length > MAX_PENDING) this.#entries = this.#entries.slice(-MAX_PENDING);
	}
}

// ---------------------------------------------------------------- signals

const RX = {
	tests: /\b(tests?|testing|test suite|specs?|jest|vitest|pytest|mocha|xunit|nunit|playwright|cypress|e2e|coverage|dotnet test|npm (?:run )?test|bun test|go test|cargo test)\b/i,
	migrations: /\b(migrations?|schema changes?|alter table|ef core|prisma migrate|flyway|alembic)\b/i,
	concurrency: /\b(concurren\w*|race conditions?|data races?|deadlocks?|threads?|mutex(?:es)?|locks?|semaphores?|atomic\w*|parallel\w*)\b/i,
	security: /\b(security|auth\w*|permissions?|secrets?|credentials?|tokens?|crypto\w*|csrf|xss|sql injection|vulnerab\w*|cve|oauth|jwt|rbac|iam)\b/i,
};

const LAYERS: Record<string, RegExp> = {
	domain: /\bdomain\b/i,
	application: /\bapplication\b/i,
	infrastructure: /\binfrastructure\b/i,
	api: /\b(api|controllers?|endpoints?)\b/i,
	ui: /\b(frontend|web|ui|components?|views?|pages?)\b/i,
	data: /\b(database|db|migrations?|persistence|repositor(?:y|ies))\b/i,
};

const PATH_RX = /(?<![:/\w])(?:~?\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|cs|py|go|rs|java|kt|sql|json|ya?ml|md|css|scss|html|razor|csproj|sln|sh|toml)\b/g;

export function extractPaths(...texts: string[]): string[] {
	const seen = new Set<string>();
	for (const text of texts) {
		for (const m of text.slice(0, 6000).matchAll(PATH_RX)) {
			const p = m[0].replace(/[.,;:)]+$/, "");
			if (p.length > 1 && p.length <= 120) seen.add(p);
			if (seen.size >= 15) return [...seen];
		}
	}
	return [...seen];
}

export function detectSignals(task: string, context: string, paths: string[]): Signals {
	const text = `${task}\n${context.slice(0, 1500)}\n${paths.join(" ")}`;
	const layers = new Set<string>();
	const layerText = `${paths.join(" ")}\n${task}`;
	for (const [name, rx] of Object.entries(LAYERS)) if (rx.test(layerText)) layers.add(name);
	return {
		runs_tests: RX.tests.test(text),
		migrations: RX.migrations.test(text),
		concurrency: RX.concurrency.test(text),
		security: RX.security.test(text),
		cross_layer: layers.size >= 2 || /\bcross[- ]layer|across (?:the )?layers\b/i.test(text),
	};
}

// ---------------------------------------------------------------- log redaction

export function redact(text: string, secrets: string[] = []): string {
	let out = text;
	for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
	return out
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\b(api[_-]?key|token|secret|password|passwd|authorization)\b\s*[=:]\s*\S+/gi, "$1=[redacted]")
		.replace(/\b(?:sk|pk|ghp|gho|ghs|xox[abprs]|AKIA)[-_A-Za-z0-9]{8,}/g, "[redacted]")
		.replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]");
}

export function summarize(task: string, secrets: string[] = [], max = 100): string {
	const one = redact(task.replace(/\s+/g, " ").trim(), secrets);
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ---------------------------------------------------------------- Jev

function tierInstructions(target: string): string {
	return `Which model tier should a coding subagent use for the work described in ${target}? A task that writes or extends tests following existing patterns can be quick. Debugging failing tests, fixing flaky tests, or test-infrastructure changes are medium or above. Tricky debugging, architecture, or changes spanning several files or layers are heavy. When unsure between two tiers, pick the higher one.`;
}

// `index` addresses one entry of `tasks` in a batched state; omitted, the question is about the single `task`.
export function tierQuestion(index?: number): ChoiceQuestion {
	const instructions =
		index === undefined
			? tierInstructions("`task`")
			: `Judge only \`tasks[${index}]\`; the other entries in \`tasks\` are separate subagents. ${tierInstructions(`\`tasks[${index}].task\``)}`;
	return {
		type: "choice",
		instructions,
		criteria: {
			heavy: rubric(
				"Architecture or design work, multi-file or cross-layer changes, tricky or intermittent debugging, concurrency, and security-sensitive or migration work.",
				["Design the retry and idempotency model across API and worker layers", "Find why the integration suite deadlocks intermittently", "Add an EF migration and update the domain, application and API layers"],
				"A rename, a lookup, a normal change confined to one area, or tests added in an existing pattern.",
			),
			medium: rubric(
				"Normal single-area feature or bug work: a bounded change in one module or layer, with ordinary complexity. Also debugging a failing test, fixing a flaky test, or a test-infrastructure change confined to one area.",
				["Add a nullable field to one DTO and its mapper", "Fix an off-by-one in the pagination helper", "Implement a new validator in one service", "Find out why the date-parsing unit test fails and fix it"],
				"Lookups, renames, mechanical edits and tests that follow an existing pattern (quick), or multi-layer and architectural work (heavy).",
			),
			quick: rubric(
				"Lookups and read-only questions, renames, small mechanical edits, commit messages, summaries, and writing or extending tests that follow existing patterns.",
				["Find where the retry policy is configured", "Rename `userId` to `accountId` in one file", "Write a commit message for this diff", "Summarize what this module does", "Add unit tests for `slugify` following the existing cases in its test file"],
				"Debugging failing tests, fixing flaky tests, test-infrastructure changes, or anything else that needs real reasoning about behaviour.",
			),
		},
	};
}

export class JevError extends Error {}

// Narrows `{ answers: { [questionId]: { type: "choice", choice, confidence } } }` without trusting the shape.
function readChoiceAnswer<T extends string>(
	payload: unknown,
	questionId: string,
	choices: readonly T[],
): ChoiceAnswer<T> | undefined {
	if (!payload || typeof payload !== "object" || !("answers" in payload)) return undefined;
	const answers = payload.answers;
	if (!answers || typeof answers !== "object" || !(questionId in answers)) return undefined;
	const answer = (answers as Record<string, unknown>)[questionId];
	if (!answer || typeof answer !== "object" || !("type" in answer) || answer.type !== "choice") return undefined;
	if (!("choice" in answer) || !("confidence" in answer)) return undefined;
	const { choice: raw, confidence } = answer;
	const choice = choices.find((c) => c === raw);
	if (!choice || typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return undefined;
	return { choice, confidence };
}

export interface ChoiceRequest<T extends string> {
	judge: JudgeFn;
	state: Record<string, unknown>;
	questionId: string;
	question: ChoiceQuestion;
	choices: readonly T[];
	/** Free-form label omp records against the usage (telemetry, session journal). */
	purpose: string;
	timeoutMs: number;
}

export interface ChoiceAnswer<T extends string> {
	choice: T;
	confidence: number;
}

export interface ChoicesRequest<T extends string> {
	judge: JudgeFn;
	state: Record<string, unknown>;
	questions: Record<string, ChoiceQuestion>;
	choices: readonly T[];
	purpose: string;
	timeoutMs: number;
}

// Several Jev Choice questions over one state in one request. A hard cap: the timer aborts the request, and a
// race guarantees the promise settles even if the judge implementation ignores the signal. Rejects on timeout
// or judge failure; otherwise maps every question id to its answer, or undefined when that answer is unusable.
export async function askChoices<T extends string>(req: ChoicesRequest<T>): Promise<Record<string, ChoiceAnswer<T> | undefined>> {
	const controller = new AbortController();
	const { promise: timeout, reject: rejectTimeout } = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		controller.abort();
		rejectTimeout(new JevError(`timeout after ${req.timeoutMs}ms`));
	}, req.timeoutMs);
	const call = (async () => {
		const response = await req.judge({
			state: req.state,
			questions: req.questions,
			purpose: req.purpose,
			signal: controller.signal,
		});
		return Object.fromEntries(Object.keys(req.questions).map((id) => [id, readChoiceAnswer(response, id, req.choices)]));
	})();
	try {
		return await Promise.race([call, timeout]);
	} finally {
		clearTimeout(timer);
		call.catch(() => {}); // a late rejection after the race is already lost must not surface
	}
}

// One Jev Choice judgment.
export async function askChoice<T extends string>(req: ChoiceRequest<T>): Promise<ChoiceAnswer<T>> {
	const answers = await askChoices({
		judge: req.judge,
		state: req.state,
		questions: { [req.questionId]: req.question },
		choices: req.choices,
		purpose: req.purpose,
		timeoutMs: req.timeoutMs,
	});
	const answer = answers[req.questionId];
	if (!answer) throw new JevError(`no usable ${req.questionId} choice/confidence in answer`);
	return answer;
}

// ---------------------------------------------------------------- the decision

export interface DecideInput {
	event: SpawnEvent;
	pending: PendingTask | undefined;
	/** `provider/id` of the parent session's live model, used to tell an inherited model from an explicit one. */
	currentModel: string | undefined;
	config: Config;
	judge: JudgeFn;
}

function hasExplicitModel(item: TaskItem | undefined): boolean {
	return item?.model !== undefined && item.model !== null && item.model !== "" && !(Array.isArray(item.model) && item.model.length === 0);
}

export function explicitReason(event: SpawnEvent, item: TaskItem | undefined, currentModel: string | undefined): string | undefined {
	if (hasExplicitModel(item)) return "explicit model on the task";
	// The default `task` agent resolves through the `task` role, which is not a pin by the agent: when it points
	// at a different model than the parent's, the model comparison below still protects it.
	if (event.modelRole && event.modelRole !== "task") return `agent/role pinned a role (${event.modelRole})`;
	const first = event.patterns?.[0];
	if (first && currentModel && first.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/i, "") !== currentModel) return "model pinned by agent or settings override";
	return undefined;
}

// Members of a `task` call that Jev should judge together: those with task text and no explicit model. Agent and
// role pins are only visible on each spawn's own event, so those members stay in and their answer goes unused.
function batchMembers(batch: TaskBatch): PendingTask[] {
	return batch.members.filter((m) => typeof m.item.task === "string" && m.item.task.trim() !== "" && !hasExplicitModel(m.item));
}

function tierBatchVerdicts(batch: TaskBatch, members: PendingTask[], judge: JudgeFn, config: Config): Promise<TierVerdicts> {
	const state = {
		context: batch.context.slice(0, 600),
		tasks: members.map((m) => {
			const task = (m.item.task as string).trim();
			const paths = extractPaths(task, batch.context);
			return {
				name: m.name,
				agent: typeof m.item.agent === "string" && m.item.agent ? m.item.agent : "task",
				task: task.slice(0, 1500),
				solutionSpace: typeof m.item.solutionSpace === "string" ? m.item.solutionSpace.slice(0, 600) : "",
				paths,
				signals: detectSignals(task, batch.context, paths),
			};
		}),
	};
	return askChoices({
		judge,
		state,
		questions: Object.fromEntries(members.map((_, i) => [`model_tier_${i}`, tierQuestion(i)])),
		choices: TIERS,
		purpose: "jev-tier:model_tier",
		timeoutMs: spawnTimeoutMs(config.timeoutMs, JSON.stringify(state).length),
	}).then((answers) => new Map(members.map((m, i) => [m, answers[`model_tier_${i}`]])));
}

export async function decide(input: DecideInput): Promise<Decision> {
	const { event, pending, config } = input;
	const secrets: string[] = [];
	const task = pending?.item.task?.trim() ?? "";
	const summary = summarize(task || `[${event.agent ?? "agent"} ${event.spawnKey ?? ""}]`, secrets);

	if (!pending || !task) return { action: "skip", reason: "no task text for this spawn (eval agent() or unnamed task)", summary };
	const explicit = explicitReason(event, pending.item, input.currentModel);
	if (explicit) return { action: "skip", reason: explicit, summary };

	const batch = pending.batch;
	const members = batch ? batchMembers(batch) : [];
	let reason = "jev choice";
	let answer: ChoiceAnswer<Tier>;
	try {
		if (batch && members.length >= 2 && members.includes(pending)) {
			// All member hooks fire within milliseconds of each other: the first creates the request, synchronously.
			if (!batch.verdicts) {
				batch.verdicts = tierBatchVerdicts(batch, members, input.judge, config);
				batch.verdicts.catch(() => {}); // members that spawn after a failure await it themselves
			}
			const got = (await batch.verdicts).get(pending);
			if (!got) throw new JevError("no usable model_tier choice/confidence for this task in the batched answer");
			answer = got;
			reason = `jev choice (batch of ${members.length})`;
		} else {
			const paths = extractPaths(task, pending.context);
			const state = {
				task: task.slice(0, 1500),
				solutionSpace: typeof pending.item.solutionSpace === "string" ? pending.item.solutionSpace.slice(0, 600) : "",
				context: pending.context.slice(0, 600),
				agent: event.agent ?? "task",
				paths,
				signals: detectSignals(task, pending.context, paths),
			};
			answer = await askChoice({
				judge: input.judge,
				state,
				questionId: "model_tier",
				question: tierQuestion(),
				choices: TIERS,
				purpose: "jev-tier:model_tier",
				timeoutMs: spawnTimeoutMs(config.timeoutMs, JSON.stringify(state).length),
			});
		}
	} catch (error) {
		const msg = redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 120);
		return { action: "skip", reason: `jev error: ${msg}`, summary };
	}
	const conf = Math.round(answer.confidence * 1000) / 1000;
	if (answer.confidence < config.minConfidence) {
		return { action: "skip", reason: `low confidence ${conf} < ${config.minConfidence}`, summary, tier: answer.choice, confidence: conf };
	}

	const tier = answer.choice;
	return { action: "apply", tier, confidence: conf, model: TIER_MODEL[tier], note: `jev-tier: ${tier} (${conf})`, reason, summary };
}

export function formatLog(decision: Decision, event: SpawnEvent, now = new Date()): string {
	const parts = [
		now.toISOString(),
		`spawn=${event.spawnKey ?? "-"}`,
		`agent=${event.agent ?? "-"}`,
		`tier=${decision.tier ?? "-"}`,
		`conf=${decision.confidence ?? "-"}`,
		`action=${decision.action === "apply" ? "applied" : "skipped"}`,
	];
	if (decision.action === "apply") parts.push(`model=${decision.model}`);
	parts.push(`reason=${JSON.stringify(decision.reason)}`, `task=${JSON.stringify(decision.summary)}`);
	return parts.join(" ");
}
