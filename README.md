# Copilot DSH Provider

A minimal localhost provider that exposes GitHub Copilot models to DeepSeek Harness through the OpenAI Responses API.

This project deliberately contains no agent loop. DeepSeek Harness owns prompts, sessions, tools, permissions, retries, and durable logs. The provider only performs GitHub authentication, refreshes the short-lived Copilot token, lists compatible models, and otherwise passes Responses requests and streams through unchanged.

One wire-compatibility normalization is applied to function tools: when `strict`
is omitted, the provider sends `strict: false` explicitly. This is the OpenAI
Responses default, but Copilot's Responses endpoint otherwise causes GPT-5.x
models to populate optional tool properties as if they were required. Explicit
`strict` values, JSON Schemas, tool arguments, call IDs, results, and stream
events are preserved.

The short-lived Copilot token refreshes automatically. After a new Device Flow
authorization is saved, the running provider reloads the GitHub token on the
next token exchange; an upstream 401 or 403 triggers one immediate reload and
retry, so restarting the provider is not required.

> [!WARNING]
> GitHub does not document or support the Copilot inference endpoints used here. They can change without notice, and automated use can trigger rate limits or account restrictions.

## Run

```powershell
bun install
bun run auth
bun run start
```

The server binds only to `127.0.0.1:4141`.

## Configure DeepSeek Harness

Add a custom provider in **Settings -> Models**:

| Field | Value |
|---|---|
| Provider ID | `copilot-proxy` |
| Display name | `GitHub Copilot` |
| Base URL | `http://127.0.0.1:4141/v1` |
| API protocol | `openai-responses` |
| API key | Any non-secret placeholder, such as `local-copilot-provider` |

Use **Fetch available models**, choose the models to expose, and save. Context and output limits are included when Copilot supplies them. Models whose Copilot metadata declares vision include `input: [text, image]`; this requires a DeepSeek Harness build whose model discovery preserves the `input` extension.

## API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Safe model-authentication readiness |
| `GET /v1/models` | Dynamic Responses-compatible model catalog |
| `POST /v1/responses` | Transparent Responses request and stream proxy |

The inbound API key is intentionally ignored. Never place a GitHub token in the Harness API-key field.

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
