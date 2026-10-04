# Copilot Model Provider

A minimal localhost provider that exposes GitHub Copilot models to OpenAI Codex
(CLI and Desktop) and DeepSeek Harness through OpenAI-compatible Responses and
Chat Completions APIs.

This project deliberately contains no agent loop. Codex or DeepSeek Harness
owns prompts, sessions, tools, permissions, retries, and durable logs. The
provider only performs GitHub authentication, refreshes the short-lived Copilot
token, lists compatible models, and otherwise passes Responses or Chat
Completions requests and streams through unchanged.

One wire-compatibility normalization is applied to function tools: when `strict`
is omitted, the provider sends `strict: false` explicitly. This is the OpenAI
Responses default, but Copilot's Responses endpoint otherwise causes GPT-5.x
models to populate optional tool properties as if they were required. Explicit
`strict` values, JSON Schemas, tool arguments, call IDs, results, and stream
events are preserved.

The short-lived Copilot token refreshes automatically. Device Flow requests
GitHub's `offline_access` scope; when GitHub issues expiring credentials, the
access and refresh tokens are stored locally and rotated before expiry, so
routine expiry does not require another interactive login. GitHub environments
that return a non-expiring token without a refresh token remain supported, as
do legacy installations with a plain-text `github-token` file. After a new
Device Flow authorization is saved, the running provider reloads the GitHub
credential on the next token exchange; an upstream authorization failure
triggers one immediate reload and retry, so restarting is not required.

> [!WARNING]
> GitHub does not document or support the Copilot inference endpoints used here. They can change without notice, and automated use can trigger rate limits or account restrictions.

## One-step Windows setup

From PowerShell, run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

The idempotent setup installs Bun for the current user when needed, installs
project dependencies, reuses a healthy GitHub credential or runs Device Flow
authentication, and registers the provider as the `Copilot DSH Provider` Task
Scheduler task. The task starts at login with highest privileges in a visible
PowerShell 7 window, runs only as the current user, and restarts after failures.
The window is titled `Copilot DSH Provider` and shows provider output for
debugging. Running `setup.ps1` again updates and restarts the task without
creating duplicates. Use `-ForceAuth` to replace an otherwise healthy
credential; its setup window displays the Device Flow URL and code.

The scheduled task only starts the localhost provider. It does not run
`codex-config`, regenerate Codex's model catalog snapshot, or force connected
clients to reload their available-model lists. Restarting the task therefore
does not by itself refresh the models shown by Codex or DeepSeek Harness.

### Install/update-only preparation

An external process manager can prepare the component without taking over its
startup lifecycle:

```powershell
.\setup.ps1 -InstallOnly
```

This mode verifies the package identity, version, lockfile, and source entrypoint,
then performs the same Bun, locked dependency, and authentication preparation. It
does not request elevation or inspect, register, unregister, start, stop, restart,
or terminate a Scheduled Task or process. `-ForceAuth` remains available when an
explicit credential replacement is intended. Omitting `-InstallOnly` preserves
the standalone task setup above.

The managed Watchdog handoff and startup registration are not delivered by this
repository or command. Until that separate handoff is completed, `-InstallOnly`
does not opt a machine into Watchdog management and does not change an existing
standalone task or provider process.

To inspect or remove the standalone task:

```powershell
Get-ScheduledTask -TaskName "Copilot DSH Provider"
Unregister-ScheduledTask -TaskName "Copilot DSH Provider" -Confirm:$false
```

## Run manually

```powershell
bun install
bun run auth
bun run start
```

The server binds only to `127.0.0.1:4141`.

## Configure OpenAI Codex CLI and Desktop

Codex CLI and Desktop share the user-level configuration at
`~/.codex/config.toml`. Generate the provider block, optionally choosing a
different default Responses-compatible Copilot model:

```powershell
bun run codex-config
# or: bun run codex-config gpt-5.6-terra
```

Merge the printed TOML into `~/.codex/config.toml`, then keep this provider
running while using either Codex client. The generated configuration is:

```toml
model = "gpt-6.1-sol"
model_provider = "github-copilot"
model_catalog_json = "C:\\Users\\you\\.copilot-dsh-provider\\codex-models.json"
model_reasoning_effort = "medium"
web_search = "disabled"

[model_providers.github-copilot]
name = "GitHub Copilot"
base_url = "http://127.0.0.1:4141/codex/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

[model_providers.github-copilot.capabilities]
remote_compaction = "unsupported"
external_web_access = false
```

Provider settings must be in the user-level file, not a project-local
`.codex/config.toml`; Codex intentionally ignores project-local
`model_provider` and `model_providers` entries. Restart Codex Desktop after
changing the file. No OpenAI API key is needed because the localhost provider
owns GitHub authentication.

The default initial selection is `gpt-6.1-sol` with the catalog's preferred
reasoning effort (`medium` when supported). The command writes a
Codex catalog snapshot containing every Responses- or Chat-Completions-compatible model in the
authorized Copilot subscription, including its context window, input
modalities, and reasoning levels. This replaces Codex's bundled picker catalog,
so unsupported built-in models are not shown. Use the model picker in CLI or
Desktop to switch models, or override one CLI run with:

```powershell
codex --model gpt-5.6-terra
```

Run `bun run codex-config` again whenever the Copilot model catalog changes,
then restart Codex Desktop or start a new Codex CLI process so it reloads the
generated catalog. The generated catalog contains model metadata only; the
GitHub credential remains inside the provider.

### Codex compatibility and long conversations

The Codex route selects the protocol from the Copilot model catalog, cached
for 60 seconds. Models supporting Responses use native Responses, including
native reasoning history. Chat-only models use a Responses-to-Chat adapter
that preserves instructions, message text, user images, function calls,
parallel call groups, textual tool results, reasoning effort, and JSON-schema
output controls. Namespace functions are flattened with collision-safe names
and restored on returned calls. Responses SSE events are emitted incrementally
with usage and sequence numbers; disconnects cancel the upstream stream.
The generic Harness routes keep their existing protocol-specific behavior.

Chat Completions cannot represent encrypted Responses reasoning history,
remote compaction items, custom/freeform tools, hosted web search, or image
tool results. Such requests receive a local `400` rather than silently losing
history or tools. Start a new conversation when switching from a native
Responses model to a Chat-only model if the existing history contains these
items. Hosted web search is disabled in the generated shared configuration;
use a client-side function/MCP search tool instead.

Keep the provider named `GitHub Copilot` and the remote-compaction capability
set to `unsupported`: Codex performs automatic and manual `/compact` through
its local summarization flow using ordinary Responses requests. The catalog
sets an explicit automatic-compaction threshold no higher than 90% of the
context window, the reported prompt limit, or the context window minus the
maximum output allowance. It includes both legacy base instructions and the
current `model_messages` instruction schema. The provider does not secretly
trim conversation content, retry oversized inference requests, or fabricate
encrypted compaction state. Calling `/codex/v1/responses/compact` directly
returns `501` with configuration guidance.

Codex request bodies support identity, gzip, deflate, and zstd encoding. The
local limit is **128 MiB**, measured on decoded UTF-8 JSON bytes as well as
Bun's transport-level body limit. A local parser rejection uses `400`, an
unsupported encoding uses `415`, and a local body-size rejection uses `413`
with code `request_body_too_large`. Upstream errors, including Copilot's
`413 failed to parse request`, retain their original status, headers, and body.
Size limits are distinct from model token limits; an upstream `413` is not
rewritten as a token-context error.

Handled inference responses carry `x-provider-error-source` (`provider`,
`upstream`, or `none`). Bun can reject oversized transport bodies before the
handler runs, so those runtime responses have no provider diagnostic header.
Runtime diagnostics are appended to
`~/.copilot-dsh-provider/provider.log`: inbound and forwarded request byte
counts, selected protocol, status, process ID, upstream request ID, and stream event
counts, never prompts, tool arguments/results, credentials, or raw errors.
After an upstream `413`, use `/compact` or start a smaller conversation and
reduce large attachments; raising the local body limit does not change the
upstream limit.

## Request instrumentation and service health

All inference aliases, model catalogs, and handled invalid routes now emit a
correlated lifecycle: `request_started`, upstream attempt records,
`response_headers`, and exactly one `request_completed`. The provider generates
the ID rather than trusting incoming headers and returns it as
`x-provider-request-id`. `requestId` is shared across lifecycle and attempt
records; `upstreamRequestId` identifies the upstream response and
`upstreamClientRequestId` the outbound request. Attempts are numbered within
each stage (`models` or `inference`); retries do not add completed requests.

Terminal records include observed request/response bytes, header latency,
first-body-byte latency, **full-body duration**, source, and outcome:
`success`, `failure`, `rejected`, `cancelled`, `incomplete`, or `unverified`.
HTTP 200 alone does not count as successful inference: Responses and Chat SSE
are inspected for completion, failure, incomplete output, malformed events,
and premature EOF. JSON failure/incomplete responses are also classified.
Read errors and client aborts finish the lifecycle even when no normal stream
flush occurs; cancellation propagates to the upstream body. Explicit timeout
abort reasons are classified separately from ordinary client cancellation.
Observation preserves response bytes and honors downstream backpressure.
Successful HTTP responses without a recognized inference terminal marker are
`unverified`, not assumed successful. Duration measurements use a monotonic
clock so wall-clock corrections do not distort latency metrics.

HTTP 401/403/429 and 5xx count as service failures. Ordinary request rejection
(including 400/413 and intentional unsupported compaction), cancellation, and
unverifiable output do not lower the service's last-observed quality state.
Invalid JSON is classified as rejection even on generic routes whose existing
HTTP error envelope retains status 502.
Incomplete output is counted separately from success. SSE inspection retains
at most one million characters per frame, and JSON inspection at most one
million bytes per response; exceeding these bounds produces `unverified`,
not an invented success or a changed response. No response text is logged.
Bytes and timing describe the provider's observed body, not client receipt
confirmation or compressed network traffic.

| Endpoint | Meaning |
|---|---|
| `GET /health/live` | HTTP 200 while the HTTP process can respond; does not call GitHub. |
| `GET /health/ready` | Existing authentication/upstream readiness payload; HTTP 200 for `ready`, otherwise 503. |
| `GET /health/metrics` | Local snapshot of uptime, PID, in-flight count, lifetime outcomes, and rolling latency/failure metrics; does not call GitHub. |
| `GET /health` | Existing readiness JSON and HTTP 200 behavior, preserved for current clients. |
| `GET /health/version` | Build identity only, independent of authentication and request quality. |

The metrics snapshot has separate dependency and service states. Dependency
tracks authentication/upstream availability; service tracks the latest
completed success, failure, or incomplete request. Health changes emit
`health` records with their scope and previous/new state. Repeated observations
refresh timestamps without repeating transitions, and `service.stale` signals
that no evaluated completion has occurred for five minutes. Overall `status`
is `unavailable` when the dependency needs reauthentication or is unreachable,
`degraded` for observed service/logging failure, `ready` when the dependency
is ready without such degradation, and otherwise `unknown`. This is not a
continuous synthetic inference probe, and concurrent completions may restore
the last-observed service state while older failures remain in window metrics.

The rolling window is **five minutes, capped at the latest 1,000 completions**;
lifetime counters survive window expiry but reset on process restart.
`failureRate` divides failures by evaluated success/failure/incomplete
completions, excluding rejection, cancellation, and unverified responses.
Header, first-byte, and full-duration p50/p95/max include the retained samples.
Health probes are excluded so polling does not inflate workload metrics.
Unknown URL paths are redacted to `/unknown`, and queries, request/response
content, credentials, raw exceptions, and arbitrary caller IDs are never
written to instrumentation logs.

Log writes are serialized. Storage errors produce a fixed stderr warning and
an observable logging failure count without breaking inference delivery;
logging degradation clears after successful writes resume. Requests rejected
by Bun before the handler, process crashes, and forced termination cannot
produce a terminal application record; supervise `/health/live` externally
for those failures.

## Configure DeepSeek Harness

Add a custom provider in **Settings -> Models** for Responses-capable models:

| Field | Value |
|---|---|
| Provider ID | `copilot-proxy` |
| Display name | `GitHub Copilot` |
| Base URL | `http://127.0.0.1:4141/responses/v1` |
| API protocol | `openai-responses` |
| API key | Any non-secret placeholder, such as `local-copilot-provider` |

Add a second custom provider for models that Copilot serves only through Chat Completions:

| Field | Value |
|---|---|
| Provider ID | `copilot-chat` |
| Display name | `GitHub Copilot Chat` |
| Base URL | `http://127.0.0.1:4141/chat/v1` |
| API protocol | `openai-completions` |
| API key | Any non-secret placeholder, such as `local-copilot-provider` |

Keep each Base URL paired with the protocol shown above. In particular,
`/responses/v1` must use `openai-responses`; if DeepSeek Harness retains or
saves `openai-completions` for that route, session requests are sent to the
wrong endpoint and fail with `404 Not found`. Correct the protocol in
**Settings -> Models** (or `~/.dsh/settings.yaml`) and restart DeepSeek Harness
if the running Web Host still shows the previous value.

Use **Fetch available models** on each route, choose the models to expose, and
save. When the Copilot catalog changes, make sure the scheduled provider is
running, use **Fetch available models** again on both routes, and restart
DeepSeek Harness if the running client still shows its previously cached list.
Restarting only the scheduled task is not sufficient because Harness controls
when model discovery is repeated. The protocol-specific catalogs include
context and output limits, `input: [text, image]` for models whose Copilot
metadata declares vision, and `reasoning_efforts` with the exact selectable
levels and wire spellings Copilot reports. Current Harness model discovery
keeps only names and capacities, so copy `input` to the model entry's `input`
field and `reasoning_efforts` to `reasoningEfforts` in `settings.yaml` until
its Models UI preserves these extensions.

Requests are passed through without collapsing conversation content. An image attached on any turn remains in that turn's Responses `input_image` or Chat Completions `image_url` content, and the selected thinking level remains in `reasoning.effort` or `reasoning_effort` respectively.

## API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Safe model-authentication readiness |
| `GET /health/version` | Local process readiness and exact build identity, without model authentication |
| `GET /codex/v1/models` | Dynamic Codex CLI/Desktop model catalog |
| `POST /codex/v1/responses` | Codex inference with native Responses or Chat Completions conversion |
| `POST /codex/v1/responses/compact` | Explicit unsupported-remote-compaction error; use Codex local `/compact` |
| `GET /responses/v1/models` | Dynamic Responses-compatible model catalog |
| `POST /responses/v1/responses` | Transparent Responses request and stream proxy |
| `GET /chat/v1/models` | Dynamic Chat Completions-compatible model catalog |
| `POST /chat/v1/chat/completions` | Transparent Chat Completions request and stream proxy |

The legacy `/v1/models`, `/v1/responses`, and `/v1/chat/completions` paths remain available. `/v1/models` lists Responses-compatible models.

The inbound API key is intentionally ignored. Never place a GitHub token in the Harness API-key field.

Generic Responses and Chat Completions inference responses are transparent upstream
responses: the provider preserves their status, status text, headers, and body,
including upstream error responses. Failures generated by the localhost
provider instead use a stable OpenAI-compatible envelope:

```json
{
  "error": {
    "message": "GitHub Copilot is temporarily unavailable.",
    "type": "api_connection_error",
    "code": "upstream-unavailable"
  }
}
```

| HTTP status | `error.type` | `error.code` | Meaning |
|---|---|---|---|
| `401` | `authentication_error` | `github-credential-rejected` | The saved GitHub credential must be replaced with `bun run auth`. |
| `403` | `permission_error` | `copilot-access-rejected` | GitHub accepted the credential but rejected Copilot access. |
| `503` | `api_connection_error` | `upstream-unavailable` | GitHub or Copilot could not be reached or returned a transient failure. |
| `502` | `provider_error` | `provider-failure` | The localhost provider could not complete the request for another reason. |

Local error messages are fixed and never include upstream bodies, credentials,
login names, or filesystem paths. A locally generated `503` includes
`Retry-After` only when the failed upstream operation supplied a valid value;
no other upstream response headers are copied into local errors.

`GET /health` validates the cached or renewed Copilot session credential and
returns one of `checking`, `ready`, `reauth-required`, or
`upstream-unavailable`. It exposes only a safe code and observation timestamp;
it never returns a token, GitHub login, credential path, or upstream error
body.

`GET /health/version` returns exactly `schemaVersion: 1`, `status: "ready"`,
`repository: "Jidong-Yang/copilot-dsh-provider"`, the package `version`, and the
40-character Git `revision`. It does not contact GitHub or read credentials;
`ready` means this local HTTP process can serve its verified build identity,
not that model authentication or inference succeeded. Use `/health` for that
separate authentication check.

Build or start from a clean Provider Git checkout. A Bun macro captures its
package version and HEAD at build/transpile time, including when using
`bun build src/main.ts --target=bun --packages=bundle --outdir=dist`.
The resulting bundle retains that identity outside the checkout without Git,
environment-supplied revision overrides, or additional deployment files.
Dirty, missing, or enclosing-only Git metadata yields HTTP `503` with code
`build-identity-unavailable` and a safe diagnostic, never a guessed identity.
Other routes remain available. Commit source changes before building an
artifact intended to pass version readiness.

## Checks

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File tests/setup.test.ps1
bun test
bun run typecheck
bun run build
```
