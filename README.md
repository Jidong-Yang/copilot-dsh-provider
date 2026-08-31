# Copilot DSH Provider

A minimal localhost provider that exposes GitHub Copilot models to DeepSeek Harness through OpenAI-compatible Responses and Chat Completions APIs.

This project deliberately contains no agent loop. DeepSeek Harness owns prompts, sessions, tools, permissions, retries, and durable logs. The provider only performs GitHub authentication, refreshes the short-lived Copilot token, lists compatible models, and otherwise passes Responses or Chat Completions requests and streams through unchanged.

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
| `GET /responses/v1/models` | Dynamic Responses-compatible model catalog |
| `POST /responses/v1/responses` | Transparent Responses request and stream proxy |
| `GET /chat/v1/models` | Dynamic Chat Completions-compatible model catalog |
| `POST /chat/v1/chat/completions` | Transparent Chat Completions request and stream proxy |

The legacy `/v1/models`, `/v1/responses`, and `/v1/chat/completions` paths remain available. `/v1/models` lists Responses-compatible models.

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
