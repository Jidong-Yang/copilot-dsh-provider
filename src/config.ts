import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const TOKEN_PATH = join(
  process.env["COPILOT_DSH_HOME"] ?? join(homedir(), ".copilot-dsh-provider"),
  "github-token",
)

const EDITOR_VERSION = process.env["COPILOT_EDITOR_VERSION"] ?? "vscode/1.133.0"
const PLUGIN_VERSION = process.env["COPILOT_PLUGIN_VERSION"] ?? "copilot-chat/0.26.7"
const USER_AGENT = process.env["COPILOT_USER_AGENT"] ?? "GitHubCopilotChat/0.26.7"

export function githubHeaders(githubToken: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `token ${githubToken}`,
    "content-type": "application/json",
    "editor-version": EDITOR_VERSION,
    "editor-plugin-version": PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "x-github-api-version": "2025-04-01",
  }
}

export function copilotHeaders(copilotToken: string, agent: boolean): Record<string, string> {
  return {
    accept: "application/json",
    authorization: ["Bearer", copilotToken].join(" "),
    "content-type": "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-version": EDITOR_VERSION,
    "editor-plugin-version": PLUGIN_VERSION,
    "openai-intent": "conversation-panel",
    "user-agent": USER_AGENT,
    "x-github-api-version": "2025-04-01",
    "x-initiator": agent ? "agent" : "user",
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  }
}
