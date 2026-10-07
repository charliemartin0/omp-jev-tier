// Automatic plan-mode detection for the jev-tier extension. Pure logic, no omp imports.

import { askChoice, extractPaths, redact, rubric, summarize, type ChoiceQuestion, type Config, type JudgeFn } from "./core";

export type PlanVerdict = "plan" | "direct";

export const PLAN_VERDICTS: readonly PlanVerdict[] = ["plan", "direct"];

export interface PlanSignals {
	multi_area: boolean;
	feature: boolean;
	refactor: boolean;
	migration: boolean;
	architecture: boolean;
	ambiguous_scope: boolean;
}

// ---------------------------------------------------------------- message signals

const RX = {
	multiArea: /\b(across|throughout|end[- ]to[- ]end|every (?:file|module|service|layer|endpoint)|all (?:the )?(?:files|modules|services|layers|endpoints)|multiple (?:files|modules|services|areas|layers)|front ?end and back ?end|api and (?:ui|web|worker))\b/i,
	feature: /\b(implement\w*|build|introduce|new feature|add support|add (?:a|an) new|create (?:a|an) new|new (?:endpoint|page|screen|command|service|module|api|flow))\b/i,
	refactor: /\b(refactor\w*|restructur\w*|re-?organi[sz]\w*|rewrite|decouple|consolidate|rework|overhaul|extract (?:a|an|the) \w+ (?:into|from))\b/i,
	migration: /\b(migrat\w*|upgrade (?:to|from)|port(?:ing)? (?:it |this |everything )?to|schema change)\b/i,
	architecture: /\b(architect\w*|system design|design (?:a|an|the)|data model|cross[- ]cutting|bounded context|layering)\b/i,
	ambiguous: /\b(somehow|not sure|figure out|improve|clean ?up|make it better|something like|whatever|overall|in general|rethink)\b/i,
	optOut: /\b(no plan(?:ning)?|skip (?:the )?plan(?:ning)?|don'?t plan|do not plan|without (?:a )?plan(?:ning)?|no need (?:to|for) plan\w*|just do it)\b/i,
};

// omp's magic keywords: exact lowercase standalone words in prose. Fenced code, inline code and HTML are ignored,
// and a word glued to letters, digits, `_`, `/`, `\`, `-`, a file extension, `::` or call syntax does not count.
const MAGIC_KEYWORD_RX = /(?<![\w/\\.:-])(jevify|orchestrate|workflowz|ultrathink)(?![\w/\\(-])(?!\.\w)(?!::)/;

export function findMagicKeyword(text: string): string | undefined {
	const prose = text
		.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/<!--[\s\S]*?-->|<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1>/g, " ")
		.replace(/<[A-Za-z/][^>]*>/g, " ");
	return MAGIC_KEYWORD_RX.exec(prose)?.[1];
}

// Leading syntax omp interprets itself: slash commands, `!`/`!!` shell, `$`/`$$` python, `->`/`=>` steer.
const SYNTAX_PREFIXES: readonly string[] = ["/", "!", "$", "->", "=>"];

export function detectPlanSignals(text: string, paths: string[]): PlanSignals {
	return {
		multi_area: paths.length >= 2 || RX.multiArea.test(text),
		feature: RX.feature.test(text),
		refactor: RX.refactor.test(text),
		migration: RX.migration.test(text),
		architecture: RX.architecture.test(text),
		ambiguous_scope: RX.ambiguous.test(text) || (paths.length === 0 && /\b(the|our) (?:app|system|codebase|project|service|pipeline|backend|frontend)\b/i.test(text)),
	};
}

// One short reason for the "Plan mode: <reason>" notice, most specific signal first.
export function planReason(signals: PlanSignals): string {
	if (signals.migration) return "migration work";
	if (signals.architecture) return "architecture change";
	if (signals.refactor) return "refactor";
	if (signals.multi_area) return "multi-file scope";
	if (signals.feature) return "new feature";
	if (signals.ambiguous_scope) return "unclear scope";
	return "multi-step work";
}

// ---------------------------------------------------------------- session state

export interface SessionView {
	/** `sessionManager.buildSessionContext().mode`: none | plan | plan_paused | goal | goal_paused | vibe. */
	mode: string;
	/** `sessionManager.getEntries()`. */
	entries: readonly unknown[];
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? block.text : ""))
		.join("");
}

// omp persists the approved-plan kickoff as a synthetic developer message that starts with "Plan approved".
// An approval is "in flight" when it is newer than the last time plan mode was entered.
export function approvedPlanInFlight(entries: readonly unknown[]): boolean {
	let approvedAt = -1;
	let planEnteredAt = -1;
	entries.forEach((entry, index) => {
		if (!entry || typeof entry !== "object" || !("type" in entry)) return;
		if (entry.type === "mode_change" && "mode" in entry && entry.mode === "plan") planEnteredAt = index;
		if (entry.type !== "message" || !("message" in entry)) return;
		const message = entry.message;
		if (!message || typeof message !== "object" || !("content" in message)) return;
		const developer = "role" in message && message.role === "developer";
		const synthetic = "synthetic" in message && message.synthetic === true;
		if ((developer || synthetic) && /^Plan approved\b/.test(messageText(message.content).trimStart())) approvedAt = index;
	});
	return approvedAt >= 0 && approvedAt > planEnteredAt;
}

// ---------------------------------------------------------------- Jev question

export function planQuestion(): ChoiceQuestion {
	return {
		type: "choice",
		instructions:
			"Should the coding agent plan first (plan mode) or act directly on `message`? If the message says to skip planning, choose direct. Questions, explanations and lookups are direct even when they mention several files. Choose plan only for work that needs a design before acting.",
		criteria: {
			plan: rubric(
				"Multi-step or multi-file work, new features, refactors, migrations, architecture changes, anything touching more than one layer, or work whose scope is unclear.",
				["Add retry and idempotency handling to the sync job across the API and worker", "Refactor the auth module and update all its callers", "Make the importer faster somehow"],
				"A question, a single small edit, or a follow-up inside work that is already planned.",
			),
			direct: rubric(
				"Questions, lookups, explanations, single small edits, git or PR housekeeping, and follow-ups inside work already planned or approved.",
				["What does the retry policy in src/sync.ts do?", "Rename userId to accountId in this file", "Commit this and open a draft PR", "Yes, go ahead with step 2"],
				"Anything that needs several coordinated changes or has unclear scope.",
			),
		},
	};
}

// ---------------------------------------------------------------- the decision

export interface PlanDecideInput {
	text: string;
	/** Event `source`: only "interactive" submissions can reach the TUI's /plan. */
	source: string | undefined;
	/** `ctx.mode`: only "tui" implements /plan. */
	uiMode: string | undefined;
	idle: boolean;
	/** omp `plan.enabled` setting: with it off, /plan would swallow the message with a warning. */
	planModeAvailable: boolean;
	/** True when omp would act on this magic keyword (global switch and its own switch both on). */
	magicKeywordActive(keyword: string): boolean;
	session: SessionView | undefined;
	config: Config;
	judge: JudgeFn;
}

export type PlanDecision =
	| { action: "switch"; verdict: "plan"; confidence: number; reason: string; summary: string }
	| { action: "skip"; reason: string; summary: string; verdict?: PlanVerdict; confidence?: number };

export async function decidePlan(input: PlanDecideInput): Promise<PlanDecision> {
	const { config } = input;
	const text = input.text.trim();
	const secrets: string[] = [];
	const summary = summarize(text, secrets, 81); // 80 characters plus the ellipsis marker
	const skip = (reason: string): PlanDecision => ({ action: "skip", reason, summary });

	if (!text) return skip("empty message");
	if (input.source !== "interactive" || input.uiMode !== "tui") return skip("not an interactive TUI submission");
	if (SYNTAX_PREFIXES.some((prefix) => text.startsWith(prefix))) return skip("omp command or shortcut syntax");
	const keyword = findMagicKeyword(text);
	if (keyword && input.magicKeywordActive(keyword)) return skip(`omp magic keyword "${keyword}" present`);
	if (RX.optOut.test(text)) return skip("message opts out of planning");
	if (!input.planModeAvailable) return skip("plan.enabled is off in omp settings");
	if (!input.session) return skip("session state unreadable");
	if (input.session.mode !== "none") return skip(`session mode is ${input.session.mode}`);
	if (approvedPlanInFlight(input.session.entries)) return skip("executing an approved plan");
	if (!input.idle) return skip("agent is busy; message would queue as a steer");

	const paths = extractPaths(text);
	const signals = detectPlanSignals(text, paths);
	let answer: { choice: PlanVerdict; confidence: number };
	try {
		answer = await askChoice({
			judge: input.judge,
			state: { message: text.slice(0, 2000), paths, signals },
			questionId: "plan_route",
			question: planQuestion(),
			choices: PLAN_VERDICTS,
			purpose: "jev-tier:plan_route",
			timeoutMs: config.timeoutMs,
		});
	} catch (error) {
		const msg = redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 120);
		return skip(`jev error: ${msg}`);
	}
	const confidence = Math.round(answer.confidence * 1000) / 1000;
	if (answer.choice === "direct") return { action: "skip", reason: "jev chose direct", summary, verdict: "direct", confidence };
	if (answer.confidence < config.planMinConfidence) {
		return { action: "skip", reason: `low confidence ${confidence} < ${config.planMinConfidence}`, summary, verdict: "plan", confidence };
	}
	return { action: "switch", verdict: "plan", confidence, reason: planReason(signals), summary };
}

export function formatPlanLog(decision: PlanDecision, now = new Date()): string {
	return [
		now.toISOString(),
		"kind=plan",
		`verdict=${decision.verdict ?? "-"}`,
		`conf=${decision.confidence ?? "-"}`,
		`action=${decision.action === "switch" ? "switched" : "skipped"}`,
		`reason=${JSON.stringify(decision.reason)}`,
		`msg=${JSON.stringify(decision.summary)}`,
	].join(" ");
}
