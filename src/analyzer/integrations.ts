import type { Integration } from "../system-snapshot/system-model.ts";
import type { Origin } from "./syntax.ts";

type Service = Omit<Integration, "id" | "evidence">;

// SDK import paths, not names of local variables or configured credentials.
const services: Record<string, Service> = {
  "zitejs/email": { name: "Zite Email", provider: "zite_email", category: "email" },
  "zitejs/integrations": { name: "Airtable", provider: "airtable", category: "database" },
  "@anthropic-ai/sdk": { name: "Anthropic", provider: "anthropic", category: "ai" },
  openai: { name: "OpenAI", provider: "openai", category: "ai" },
  "@google/genai": { name: "Gemini", provider: "gemini", category: "ai" },
  stripe: { name: "Stripe", provider: "stripe", category: "payments" },
  "@slack/web-api": { name: "Slack", provider: "slack", category: "messaging" },
  "@notionhq/client": { name: "Notion", provider: "notion", category: "database" },
};

export function integrationFor(call: Origin): Service | undefined {
  const service = services[call.module];
  if (!service || call.members.length < 2) return;
  // Constructing an SDK or its HTTP transport is not a service call.
  if (!call.instance && !call.module.startsWith("zitejs/")) return;
  return service;
}
