import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { getSettings } from "@/lib/localDb";

const DEFAULT_VAULT = path.join(os.homedir(), "storage", "shared", "Documents", "Obsidian", "9router-memory");
let graphifyRunning = false;
let graphifyQueued = false;

function cleanText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => cleanText(part?.text ?? part)).filter(Boolean).join("\n");
  if (value && typeof value === "object") return cleanText(value.text ?? value.content ?? "");
  return "";
}

function safeFilePart(value) {
  return String(value || "chat").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "chat";
}

function expandHome(value) {
  const input = String(value || "").trim();
  return input === "~" ? os.homedir() : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
}

function yaml(value) {
  return JSON.stringify(String(value ?? "")).replace(/^"|"$/g, "\\\"");
}

function getUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.filter((message) => message?.role === "user").map((message) => cleanText(message.content)).filter(Boolean).join("\n\n");
}

function getAssistantText(content) {
  return cleanText(content).trim();
}

async function runGraphify(vault) {
  if (graphifyRunning) {
    graphifyQueued = true;
    return;
  }
  graphifyRunning = true;
  try {
    await fs.mkdir(vault, { recursive: true });
    await new Promise((resolve) => {
      const child = spawn("graphify", [vault], { cwd: vault, detached: false, stdio: "ignore" });
      child.once("error", (error) => console.warn(`[Memory] Graphify unavailable: ${error.message}`));
      child.once("close", (code) => {
        if (code && code !== 0) console.warn(`[Memory] Graphify exited with code ${code}`);
        resolve();
      });
    });
  } finally {
    graphifyRunning = false;
    if (graphifyQueued) {
      graphifyQueued = false;
      setTimeout(() => runGraphify(vault).catch(() => {}), 1000);
    }
  }
}

/**
 * Persist a completed chat without ever blocking or failing the API response.
 * Obsidian writes are local Markdown; Graphify is optional and only runs when
 * explicitly enabled with auto-refresh enabled.
 */
export async function persistChatMemory({ body, content, provider, model, stream = false }) {
  try {
    const settings = await getSettings();
    const obsidianEnabled = settings.obsidianEnabled === true;
    const graphifyEnabled = settings.graphifyEnabled === true;
    if (!obsidianEnabled && !graphifyEnabled) return;

    const vault = expandHome(settings.obsidianVault || process.env.OBSIDIAN_VAULT || DEFAULT_VAULT);
    if (!vault) return;
    await fs.mkdir(vault, { recursive: true });

    const now = new Date();
    const iso = now.toISOString();
    const day = iso.slice(0, 10);
    const fileName = `${iso.replace(/[:.]/g, "-")}-${safeFilePart(model)}.md`;
    const conversationsDir = path.join(vault, "Conversations");
    const filePath = path.join(conversationsDir, fileName);
    const userText = getUserText(body);
    const assistantText = getAssistantText(content);

    if (obsidianEnabled && (userText || assistantText)) {
      await fs.mkdir(conversationsDir, { recursive: true });
      const markdown = [
        "---",
        `source: 9router`,
        `created: ${yaml(iso)}`,
        `date: ${yaml(day)}`,
        `provider: ${yaml(provider)}`,
        `model: ${yaml(model)}`,
        `stream: ${Boolean(stream)}`,
        "tags:",
        "  - 9router",
        "  - ai-chat",
        "---",
        "",
        `# Chat ${iso}`,
        "",
        "## User",
        "",
        userText || "(empty)",
        "",
        "## Assistant",
        "",
        assistantText || "(empty)",
        "",
      ].join("\n");
      await fs.writeFile(filePath, markdown, "utf8");
    }

    if (graphifyEnabled && settings.graphifyAutoRefresh === true) {
      await runGraphify(vault);
    }
  } catch (error) {
    // Memory must never break a provider response, including on Android paths.
    console.warn(`[Memory] persistence skipped: ${error.message}`);
  }
}

export function scheduleChatMemory(args) {
  Promise.resolve().then(() => persistChatMemory(args)).catch((error) => {
    console.warn(`[Memory] background persistence failed: ${error.message}`);
  });
}

export { DEFAULT_VAULT };
