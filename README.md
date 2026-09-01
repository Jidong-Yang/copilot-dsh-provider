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

To inspect or remove the task:

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
model = "gpt-5.6-sol"
model_provider = "github-copilot"
model_catalog_json = "C:\\Users\\you\\.copilot-dsh-provider\\codex-models.json"

[model_providers.github-copilot]
name = "GitHub Copilot"
base_url = "http://127.0.0.1:4141/codex/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

Provider settings must be in the user-level file, not a project-local
`.codex/config.toml`; Codex intentionally ignores project-local
`model_provider` and `model_providers` entries. Restart Codex Desktop after
changing the file. No OpenAI API key is needed because the localhost provider
owns GitHub authentication.

The model in `codex-config` is only the initial selection. The command writes a
Codex catalog snapshot containing every Responses-compatible model in the
authorized Copilot subscription, including its context window, input
modalities, and reasoning levels. This replaces Codex's bundled picker catalog,
so unsupported built-in models are not shown. Use the model picker in CLI or
Desktop to switch models, or override one CLI run with:

```powershell
codex --model gpt-5.6-terra
```

Run `bun run codex-config` again whenever the Copilot model catalog changes,
then restart Codex Desktop. The generated catalog contains model metadata only;
the GitHub credential remains inside the provider.

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

Use **Fetch available models** on each route, choose the models to expose, and save. The protocol-specific catalogs include context and output limits, `input: [text, image]` for models whose Copilot metadata declares vision, and `reasoning_efforts` with the exact selectable levels and wire spellings Copilot reports. Current Harness model discovery keeps only names and capacities, so copy `input` to the model entry's `input` field and `reasoning_efforts` to `reasoningEfforts` in `settings.yaml` until its Models UI preserves these extensions.

Requests are passed through without collapsing conversation content. An image attached on any turn remains in that turn's Responses `input_image` or Chat Completions `image_url` content, and the selected thinking level remains in `reasoning.effort` or `reasoning_effort` respectively.

## API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Safe model-authentication readiness |
| `GET /codex/v1/models` | Dynamic Codex CLI/Desktop model catalog |
| `POST /codex/v1/responses` | Codex Responses request and stream proxy |
| `GET /responses/v1/models` | Dynamic Responses-compatible model catalog |
| `POST /responses/v1/responses` | Transparent Responses request and stream proxy |
| `GET /chat/v1/models` | Dynamic Chat Completions-compatible model catalog |
| `POST /chat/v1/chat/completions` | Transparent Chat Completions request and stream proxy |

The legacy `/v1/models`, `/v1/responses`, and `/v1/chat/completions` paths remain available. `/v1/models` lists Responses-compatible models.

The inbound API key is intentionally ignored. Never place a GitHub token in the Harness API-key field.

Responses and Chat Completions inference responses are transparent upstream
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

## Checks

```powershell
bun test
bun run typecheck
bun run build
```
