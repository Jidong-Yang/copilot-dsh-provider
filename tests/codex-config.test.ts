import { expect, test } from "bun:test"

import { codexConfig } from "../src/codex-config.ts"

test("generates a shared Codex CLI and Desktop provider configuration", () => {
  expect(codexConfig(
    "gpt-5.6-sol",
    4141,
    "C:\\provider\\codex-models.json",
  )).toBe([
    'model = "gpt-5.6-sol"',
    'model_provider = "github-copilot"',
    'model_catalog_json = "C:\\\\provider\\\\codex-models.json"',
    "",
    "[model_providers.github-copilot]",
    'name = "GitHub Copilot"',
    'base_url = "http://127.0.0.1:4141/codex/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
  ].join("\n"))
})

test("escapes model names as TOML basic strings", () => {
  const config = (model: string) =>
    codexConfig(model, 5151, "C:\\provider\\codex-models.json")
  expect(config('model"name')).toContain('model = "model\\"name"')
  expect(config("model\nname")).toContain('model = "model\\nname"')
})
