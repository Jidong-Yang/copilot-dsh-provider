import { expect, test } from "bun:test"

import { codexConfig } from "../src/codex-config.ts"

test("generates a shared Codex CLI and Desktop provider configuration", () => {
  expect(codexConfig(
    "gpt-6.1-sol",
    4141,
    "C:\\provider\\codex-models.json",
    "medium",
  )).toBe([
    'model = "gpt-6.1-sol"',
    'model_provider = "github-copilot"',
    'model_catalog_json = "C:\\\\provider\\\\codex-models.json"',
    'model_reasoning_effort = "medium"',
    'web_search = "disabled"',
    "",
    "[model_providers.github-copilot]",
    'name = "GitHub Copilot"',
    'base_url = "http://127.0.0.1:4141/codex/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
    "[model_providers.github-copilot.capabilities]",
    'remote_compaction = "unsupported"',
    "external_web_access = false",
    "",
  ].join("\n"))
})

test("escapes model names as TOML basic strings", () => {
  const config = (model: string) =>
    codexConfig(model, 5151, "C:\\provider\\codex-models.json")
  expect(config('model"name')).toContain('model = "model\\"name"')
  expect(config("model\nname")).toContain('model = "model\\nname"')
})

test("does not impose reasoning effort on models without reasoning support", () => {
  expect(codexConfig("chat-model", 4142, "catalog.json", null)).not.toContain("model_reasoning_effort")
  expect(codexConfig("low-only", 4142, "catalog.json", "low")).toContain('model_reasoning_effort = "low"')
})
