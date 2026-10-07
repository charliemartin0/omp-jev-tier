// omp-only: the native Jev judge adapter, shared by jev-tier and auto-retro so both use one client and key.
import { hasNativeJudge, journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";
import type { JudgeRequest } from "./core";
import type { ExtensionContext } from "./register";

// One judgment through omp's own judge: the `judge` model role and its fallback chain, the shared judgment
// cache, the account's credentials (env or /login, gateway baseUrl included) and usage journaling, i.e. the
// same plumbing the auto-thinking classifier and `judge()` use. Only a native System One (Jev) candidate may
// answer: a chain that starts at a prompted chat or on-device model would turn a "cheap Jev decision" into a
// paid LLM call, so that case throws and the caller fails open.
export function createNativeJudge(settings: unknown): (context: ExtensionContext, request: JudgeRequest) => Promise<unknown> {
	return async (context, request) => {
		const registry = context.modelRegistry;
		if (!registry || !hasNativeJudge(settings, registry)) throw new Error("judge role does not resolve to a native Jev model");
		const chain = resolveJudge({
			settings,
			registry,
			sessionModel: context.model,
			sessionId: context.sessionManager?.getSessionId?.(),
			purpose: request.purpose,
			cache: sharedJudgmentCache(),
			onUsage: journalJudgmentUsage(context.sessionManager),
		});
		return chain.withCandidate(
			async (candidate, kind) => {
				if (kind !== "native") throw new Error("non-native judge candidate skipped");
				return candidate.judge({ state: request.state, questions: request.questions }, { signal: request.signal });
			},
			{ signal: request.signal },
		);
	};
}
