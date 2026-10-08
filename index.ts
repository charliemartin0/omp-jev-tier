// omp entry point. Kept thin: the omp-only imports live here so register.ts stays runnable under plain bun
// for test.ts. Everything else is in register.ts / core.ts / plan.ts.
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { createNativeJudge } from "./judge";
import { register, type ExtensionAPI } from "./register";

interface OmpExtensionAPI extends ExtensionAPI {
	pi: { settings: unknown };
}

// The omp setting that gates each magic keyword's hidden notice (`workflowz` is `magicKeywords.workflow`).
const MAGIC_KEYWORD_SETTING: Record<string, string> = {
	jevify: "magicKeywords.jevify",
	orchestrate: "magicKeywords.orchestrate",
	workflowz: "magicKeywords.workflow",
	ultrathink: "magicKeywords.ultrathink",
};

export default function (pi: OmpExtensionAPI): void {
	const planEnabled = lookup("plan.enabled");
	const magicEnabled = lookup("magicKeywords.enabled");

	const judge = createNativeJudge(pi.pi.settings);

	register(pi, {
		agentDir: getAgentDir(),
		// `/plan` swallows the message with a warning when plan.enabled is false, so anything other than an
		// explicit `true` (including a missing registry handle) means "do not rewrite to /plan".
		planModeAvailable: () => planEnabled?.get(pi.pi.settings) === true,
		// omp's defaults are all `true`, so an unknown keyword or missing handle counts as active.
		magicKeywordActive: (keyword) =>
			magicEnabled?.get(pi.pi.settings) !== false && lookup(MAGIC_KEYWORD_SETTING[keyword] ?? "")?.get(pi.pi.settings) !== false,
		judge,
	});
}
