# omp-jev-tier

An omp extension for Jev-based subagent model tiering and automatic plan mode. It uses **omp's native judge**, not a separate API client, and does not patch omp or change your configured model roles, fallback chains, or usage reserve.

## Requirements and installation

- Compatibility target: **omp 18.8.4**. Older versions are not verified.
- **Bun >=1.3.14** for installation and contributor commands.
- Configure omp's `judge` model role with an eligible native Jev model (normally `typesafe/jev-latest`), and authenticate with `TYPESAFE_API_KEY` or omp's `/login typesafe`. Your account/gateway must support native Jev judgments. Gateway `baseUrl` and credentials remain host configuration, not extension configuration.

Install the source package through omp:

```sh
omp plugin install github:charliemartin0/omp-jev-tier
```

For a local contributor checkout:

```sh
git clone https://github.com/charliemartin0/omp-jev-tier.git
omp plugin link /absolute/path/to/omp-jev-tier
```

Or load the entry explicitly for a session:

```sh
omp --no-extensions -e /absolute/path/to/omp-jev-tier/index.ts
```

Use one activation method: do not enable clone-directory discovery and a linked installation simultaneously. The source package's `omp.extensions` manifest points at `./index.ts`; there is no build or dependency-install step. See omp's [extension loading](https://github.com/can1357/oh-my-pi/blob/v18.8.4/docs/extension-loading.md) and [plugin installer](https://github.com/can1357/oh-my-pi/blob/v18.8.4/docs/plugin-manager-installer-plumbing.md) documentation.

Only a native Jev candidate may answer. If the host's judge role resolves to a prompted chat or on-device model, this extension refuses that judgment rather than making a surprise paid chat fallback call. Native judgments use omp's shared judgment cache, usage journaling and telemetry (purposes `jev-tier:model_tier` and `jev-tier:plan_route`). Jev service usage may incur charges under your account's terms. Caching does not imply all requests are free.

## Behavior

### Subagent tiers

Named `task` tool items are classified as **heavy**, **medium**, or **quick** and routed to the configured model selector (by default `@slow`, `@default`, or `@smol`). Selectors are omp role aliases or concrete `provider/id` selectors; omp resolves them. Configure the corresponding models in omp, not with extension-owned provider credentials.

The spawn event has no task text, so the extension captures task-tool input and correlates it using `spawnKey`. Unnamed tasks and eval `agent()` spawns are left alone. Two or more eligible items in a task call share a batched judgment, with a separate verdict for each item. A failed batch leaves every member unchanged.

Explicit task `model` choices, agents pinned to a role other than `task`, and spawns whose resolved model differs from the parent's are never overridden. The default agent's `task` role alone is not a pin. Low confidence, errors, aborts and timeouts leave ordinary omp routing unchanged. Tiering and native auto-thinking classify different things (model tier versus reasoning effort); native features continue to use the host's own settings and Jev budget.

### Automatic plan mode

For eligible main-session interactive TUI input, the extension judges `plan` versus `direct`. A confident `plan` verdict rewrites the message as `/plan <message>`, using omp's normal plan-mode/model transition. An explicit request such as “make a plan” can switch without a Jev call. A `Plan mode: <reason>` notification accompanies the host's normal transition.

Detection does not act in plan/paused-plan/goal/vibe modes, while executing an approved plan, when the agent is busy, in subagent sessions, or when omp's `plan.enabled` is off. It leaves omp command syntax (`/`, `!`, `!!`, `$`, `->`, `=>`) and active host magic keywords (`jevify`, `orchestrate`, `workflowz`, `ultrathink`) alone. To skip it for one message, include “no plan”, “skip planning”, “don't plan”, “without a plan”, or “just do it”. Judge errors, low confidence and timeouts leave the original input unchanged.

## Configuration

Configuration belongs to the **active omp profile**, not the managed package/clone directory. The default file is `<agentDir>/extensions/jev-tier/config.json`, where `agentDir` comes from omp's native [`getAgentDir()`](https://github.com/can1357/oh-my-pi/blob/v18.8.4/packages/utils/src/dirs.ts). This respects profiles and config-root/agent-dir overrides. For the default profile it is normally `~/.omp/agent/extensions/jev-tier/config.json`.

There is deliberately no active `config.json` shipped. Create the directory and copy `config.example.json` from your checkout to the selected profile location, or manually create the file using this complete default configuration:

```json
{
  "enabled": true,
  "tierEnabled": true,
  "planEnabled": true,
  "tierModels": {
    "heavy": "@slow",
    "medium": "@default",
    "quick": "@smol"
  },
  "timeoutMs": 3000,
  "planTimeoutMs": 3000,
  "minConfidence": 0.7,
  "planMinConfidence": 0.6,
  "logging": {
    "enabled": true,
    "includeText": false
  }
}
```

| Key | Default | Accepted value / effect |
| --- | --- | --- |
| `enabled` | `true` | Boolean; master switch for both features. |
| `tierEnabled` | `true` | Boolean; independently enables tier routing. |
| `planEnabled` | `true` | Boolean; independently enables plan detection. |
| `tierModels.heavy` | `"@slow"` | Trimmed nonempty model-selector string. |
| `tierModels.medium` | `"@default"` | Trimmed nonempty model-selector string. |
| `tierModels.quick` | `"@smol"` | Trimmed nonempty model-selector string. |
| `timeoutMs` | `3000` | Positive finite number; tier judgment base in milliseconds, capped at `8000`. |
| `planTimeoutMs` | `3000` normally | Positive finite number capped at `8000`; independent plan judgment base. If absent/invalid, uses `min(parsed timeoutMs, 3000)`. |
| `minConfidence` | `0.7` | Finite number in `[0,1]`; tier verdict must meet this threshold. |
| `planMinConfidence` | `0.6` | Finite number in `[0,1]`; plan verdict must meet this threshold. |
| `logging.enabled` | `true` | Boolean; false prevents log-directory creation and log writes. |
| `logging.includeText` | `false` | Boolean; opt into task/message excerpts and detailed judge errors. |
| `logging.path` | absent | Trimmed nonempty logfile path; otherwise uses the profile default below. |

Partial `tierModels` and `logging` objects merge **per field** into fresh defaults. Absent, empty, wrong-type or invalid fields keep their field defaults (with the documented `planTimeoutMs` fallback). Booleans must be JSON booleans, not strings. Arrays are not accepted as objects; unknown keys are ignored. Positive fractional timeout values are allowed. The parser rejects nonfinite numbers; JSON itself cannot represent `NaN` or `Infinity`.

Both timeout bases retain text-length scaling and an 8-second hard cap. Tier scaling grows with judgment state size (up to 8000 characters); plan scaling grows with message length (500–2000 characters). A small configured base is not a constant deadline for all message sizes. A hard timeout race also protects against a judge that ignores abort.

### File and environment precedence

| Selection | Precedence, highest first |
| --- | --- |
| Config file | Explicit registration `configPath` (embedding/test API), nonblank `JEV_TIER_CONFIG`, `<agentDir>/extensions/jev-tier/config.json`. |
| Log file | Explicit registration `logPath` (test API), `logging.path`, `<agentDir>/logs/jev-tier.log`. |

Config override paths resolve relative to startup working directory. A configured relative log path resolves relative to the **selected config file's directory**. Paths support a leading `~` or `~/` for the home directory, not shell expressions or arbitrary environment-variable expansion. Whitespace-only environment config paths are ignored.

The selected JSON is read on each relevant hook: edits apply without restarting. A missing default file silently uses defaults. A missing explicitly selected file, unreadable file, malformed JSON, or non-object/array root **disables both routes for that hook**. When a UI notifier is available, the only warning is:

```text
jev-tier: cannot read configuration; routing disabled until fixed
```

It appears once per consecutive failure period, without file contents, parser details or secrets. Fixing the file restores behavior automatically and resets warning suppression. Notification failures cannot interrupt input/spawn handling; the extension never rewrites your config. Individually invalid fields in an otherwise valid object fall back as described above.

Environment switches only disable; they cannot override a JSON `false` back to enabled:

| Variable | Effect |
| --- | --- |
| `JEV_TIER=off` | Disables the entire extension. |
| `JEV_PLAN=off` | Disables only automatic plan detection. |
| `JEV_TIER_CONFIG=/path/to/config.json` | Selects a config file (not a feature switch). |

Both disable switches also accept `0`, `false`, `no`, `disabled`, and `disable`, case-insensitively with surrounding whitespace ignored. Other values do not force features on. There are no parallel environment variables for every JSON setting.

For example, preserve plan detection while disabling tiering:

```json
{"tierEnabled": false, "planEnabled": true}
```

Conversely, `{"planEnabled": false}` leaves tiering enabled; `{"enabled": false}` disables both. A partial selector override such as `{"tierModels":{"quick":"@default"}}` leaves heavy/medium defaults intact.

## Logging and privacy

By default, local logs contain decision metadata (tier/verdict, confidence, action, fixed reasons) **without `task=` or `msg=` excerpts**. Detailed `jev error:` reasons become the fixed `jev error`. Metadata can still include spawn/agent identifiers; this is not an anonymous audit log.

The default logfile is `<agentDir>/logs/jev-tier.log`. New files are appended with mode `0600`; existing file permissions are not changed. File errors are silent and do not affect routing. Free-text fields are JSON-quoted. Disable logging entirely with `{"logging":{"enabled":false}}`.

For a **custom-path, text-opt-in example**, not the defaults:

```json
{
  "logging": {
    "enabled": true,
    "includeText": true,
    "path": "./logs/jev-tier.log"
  }
}
```

This path is relative to the selected config's directory. Text opt-in preserves truncated task/message excerpts and detailed judge errors. Excerpt credential redaction is heuristic, **not guaranteed**; review logs before sharing and avoid enabling text logging for sensitive work. Metadata-only local logging does **not** mean task/message text stays on your machine: eligible judgments send state to your configured native Jev service, and omp has its own cache, telemetry and usage records.

## Disable, uninstall and troubleshoot

For a temporary full disable, start `JEV_TIER=off omp`; for only plan detection, use `JEV_PLAN=off omp`. For persistent control use the JSON switches above. Remove a managed or linked package with:

```sh
omp plugin uninstall omp-jev-tier
```

If loading explicitly, stop passing `-e`; if using clone discovery, remove that discovery activation. Your profile configuration/logs are separate from the package; manage them yourself if no longer needed.

Local troubleshooting:

1. Run `omp plugin list --json` and `omp plugin doctor --json` to inspect installation; check that only one activation method is in use and that the host matches the compatibility target.
2. Check the active profile's `agentDir`, `JEV_TIER_CONFIG`, and JSON syntax. The sanitized config warning means routing is disabled until the selected file is fixed, not that defaults were applied.
3. Check master/feature/environment switches, the confidence thresholds, eligible named task inputs, explicit model/agent pins, and plan-mode exclusions. No override is often intentional.
4. Verify the host's `judge` role, native Jev support and Typesafe login/API key. Do not add a chat fallback to work around an unsupported native candidate. Metadata logs can show fixed error reasons; opt into details only if safe.
5. Run the offline contributor harness below. It does not prove live account/gateway availability.

## Contributing and tests

From the checkout, run:

```sh
bun run test
```

This invokes the existing top-level `test.ts` executable harness, not a `bun test` runner suite. It uses scripted judges and owned temporary config/log directories, restores changed `JEV_*` environment values, and does not require provider credentials or make network requests. CI runs the same command with Bun `1.4.2`, pinned checkout/setup actions, and a single check named **Tests**; no install, secrets or publishing step is needed. Runtime modules are provided by omp's loader, so this source package has no runtime npm dependencies.

Package version `0.1.0` is metadata, not an npm publication or release. The package is marked `private: true` to prevent accidental npm publication; source installation through GitHub is supported. Licensed under [MIT](LICENSE).
