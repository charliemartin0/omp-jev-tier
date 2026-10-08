import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	TaskIndex,
	decide,
	formatLog,
	isOff,
	isPlanOff,
	parseConfig,
	type Config,
	type JudgeRequest,
	type SpawnEvent,
} from "./core";
import { decidePlan, formatPlanLog, type SessionView } from "./plan";

export interface ExtensionContext {
	mode?: string;
	agent?: { kind?: string };
	isIdle?(): boolean;
	ui?: { notify?(message: string, level?: string): void };
	setTimeout?(callback: () => void, ms: number): unknown;
	/** The session's live model; handed to omp's judge chain as its last-resort candidate. */
	model?: unknown;
	/** omp's ModelRegistry; opaque here, only the native judge adapter in index.ts uses it. */
	modelRegistry?: unknown;
	models?: { current(): { provider: string; id: string } | undefined };
	sessionManager?: {
		buildSessionContext(): { mode?: string };
		getEntries(): readonly unknown[];
		getSessionId?(): string;
	};
}
export interface ExtensionAPI {
	on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown): void;
}
export interface Dependencies {
	/** omp's native, profile-aware agent directory. */
	agentDir: string;
	/** Explicit config selection, ahead of JEV_TIER_CONFIG and the profile default. */
	configPath?: string;
	/** True when omp's `plan.enabled` setting allows /plan. */
	planModeAvailable(): boolean;
	/** True when omp would act on this magic keyword (`magicKeywords.enabled` and the keyword's own switch). */
	magicKeywordActive(keyword: string): boolean;
	/** Runs one judgment through omp's native judge for this session; throws when Jev is unavailable. */
	judge(context: ExtensionContext, request: JudgeRequest): Promise<unknown>;
	/** Explicit log selection, ahead of configuration and the profile default. */
	logPath?: string;
}
interface ToolCallEvent {
	toolName?: string;
	input?: unknown;
}
interface InputEvent {
	text?: string;
	source?: string;
}

const NOTICE_DELAY_MS = 400;
const CONFIG_WARNING = "jev-tier: cannot read configuration; routing disabled until fixed";

function resolvePath(path: string, base: string): string {
	const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	return resolve(base, expanded);
}

function createConfigReader(configPath: string, explicitlySelected: boolean): (context: ExtensionContext) => Config {
	let warned = false;
	return (context) => {
		try {
			let text: string;
			try {
				text = readFileSync(configPath, "utf8");
			} catch (error) {
				if (!explicitlySelected && error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
					warned = false;
					return parseConfig(undefined);
				}
				throw error;
			}
			const raw: unknown = JSON.parse(text);
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid configuration root");
			const config = parseConfig(raw);
			warned = false;
			return config;
		} catch {
			if (!warned && context.ui?.notify) {
				warned = true;
				try {
					context.ui.notify(CONFIG_WARNING, "warning");
				} catch {
					// A UI failure cannot hold a spawn or message.
				}
			}
			return { ...parseConfig(undefined), enabled: false };
		}
	};
}

function currentModel(context: ExtensionContext): string | undefined {
	try {
		const model = context.models?.current();
		return model ? `${model.provider}/${model.id}` : undefined;
	} catch {
		return undefined;
	}
}

function readSession(context: ExtensionContext): SessionView | undefined {
	try {
		const manager = context.sessionManager;
		if (!manager) return undefined;
		const mode = manager.buildSessionContext().mode;
		return typeof mode === "string" ? { mode, entries: manager.getEntries() } : undefined;
	} catch {
		return undefined;
	}
}

export function register(pi: ExtensionAPI, deps: Dependencies): void {
	const cwd = process.cwd();
	const agentDir = resolvePath(deps.agentDir, cwd);
	const override = deps.configPath ?? (process.env.JEV_TIER_CONFIG?.trim() || undefined);
	const configPath = override === undefined ? join(agentDir, "extensions", "jev-tier", "config.json") : resolvePath(override, cwd);
	const readConfig = createConfigReader(configPath, override !== undefined);
	const tasks = new TaskIndex();
	const logDecision = (config: Config, line: string): void => {
		const logPath = deps.logPath !== undefined
			? resolvePath(deps.logPath, cwd)
			: config.logging.path !== undefined
				? resolvePath(config.logging.path, dirname(configPath))
				: join(agentDir, "logs", "jev-tier.log");
		try {
			mkdirSync(dirname(logPath), { recursive: true });
			appendFileSync(logPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
		} catch {
			// Logging must never hold a spawn or a message.
		}
	};

	pi.on("tool_call", (rawEvent) => {
		const event = rawEvent as ToolCallEvent;
		if (event.toolName === "task") tasks.remember(event.input);
	});

	pi.on("before_subagent_spawn", async (rawEvent, context) => {
		const event = rawEvent as SpawnEvent;
		const config = readConfig(context);
		if (isOff(process.env, config) || !config.tierEnabled) return;

		const pending = tasks.take(event.spawnKey);
		const decision = await decide({
			event,
			pending,
			currentModel: currentModel(context),
			config,
			judge: (request) => deps.judge(context, request),
		});
		if (config.logging.enabled) logDecision(config, formatLog(decision, event, new Date(), config.logging.includeText));
		if (decision.action === "apply") return { model: decision.model, note: decision.note };
		return;
	});

	// Plan-mode detection. The `input` hook runs at submission ingress, before omp parses commands, and only
	// for main-session submissions. Entering plan mode = handing omp `/plan <message>`, the same path the
	// slash command takes (enters plan mode, then submits <message> inside it). Any failure returns nothing,
	// so the message goes through untouched.
	pi.on("input", async (rawEvent, context) => {
		try {
			const event = rawEvent as InputEvent;
			const config = readConfig(context);
			if (isOff(process.env, config) || isPlanOff(process.env, config)) return;
			if (context.agent?.kind === "sub" || typeof event.text !== "string") return;

			const decision = await decidePlan({
				text: event.text,
				source: event.source,
				uiMode: context.mode,
				idle: context.isIdle?.() ?? false,
				planModeAvailable: deps.planModeAvailable(),
				magicKeywordActive: (keyword) => deps.magicKeywordActive(keyword),
				session: readSession(context),
				config,
				judge: (request) => deps.judge(context, request),
			});
			if (config.logging.enabled) logDecision(config, formatPlanLog(decision, new Date(), config.logging.includeText));
			if (decision.action !== "switch") return;
			// /plan writes its own "Plan mode enabled" status line in the same tick, and omp overwrites a trailing
			// status line, so emit ours just after it (managed timer: a throw cannot take the session down).
			const notice = `Plan mode: ${decision.reason}`;
			const announce = () => context.ui?.notify?.(notice, "info");
			if (context.setTimeout) context.setTimeout(announce, NOTICE_DELAY_MS);
			else announce();
			return { text: `/plan ${event.text.trim()}` };
		} catch {
			return;
		}
	});
}
