export function codexConfig(
  model: string,
  port: number,
  catalogPath: string,
): string {
  return [
    `model = ${tomlString(model)}`,
    'model_provider = "github-copilot"',
    `model_catalog_json = ${tomlString(catalogPath)}`,
    "",
    "[model_providers.github-copilot]",
    'name = "GitHub Copilot"',
    `base_url = "http://127.0.0.1:${port}/codex/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
  ].join("\n")
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}
