import path from "node:path";
import { z } from "zod";
import { registerSecret } from "./redact.js";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const flag = optionalString.transform((v) => v === "1" || v?.toLowerCase() === "true");

const intWithDefault = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  optionalString.transform((v, ctx) => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: "custom", message: `expected an integer in [${min}, ${max}]` });
      return z.NEVER;
    }
    return n;
  });

const EnvSchema = z.object({
  MARMALADE_BASE_URL: optionalString.pipe(z.url().optional()),
  MARMALADE_API_KEY: optionalString,
  MAILBOX_ID: optionalString,

  // Which model writes drafts. Defaults to whichever API key is set (Anthropic first).
  LLM_PROVIDER: optionalString.pipe(z.enum(["anthropic", "openai"]).optional()),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: optionalString.transform((v) => v ?? "claude-opus-5-5"),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString.transform((v) => v ?? "gpt-5.5"),

  UNANSWERED_LOOKBACK_DAYS: intWithDefault(30, 1),
  LEARN_FROM_DAYS: intWithDefault(180, 0),
  LEARN_MAX_EXAMPLES: intWithDefault(100, 0),
  LONG_THREAD_MESSAGES: intWithDefault(6, 1),
  DASHBOARD_PORT: intWithDefault(4545, 1, 65535),
  // Seconds between replies when sending confirmations in bulk, so Jelly doesn't rate-limit us.
  BULK_SEND_GAP_SECONDS: intWithDefault(3, 1, 600),

  // Link to a conversation in Jelly, with {id} for the conversation id. Used when Marmalade has no url.
  JELLY_CONVERSATION_URL: optionalString,
  // shadow: approving copies the reply. send: approving sends it through Jelly.
  MODE: optionalString.pipe(z.enum(["shadow", "send"]).optional()).transform((v) => v ?? "shadow"),
  KILL_SWITCH: flag,
  JELLY_SESSION_COOKIE: optionalString,
  JELLY_BASE_URL: optionalString.transform((v) => (v ?? "https://app.letsjelly.com").replace(/\/+$/, "")),
  JELLY_TEAM: optionalString.transform((v) => v ?? "hack-club"),
  JELLY_TIMEZONE: optionalString.transform((v) => v ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
  SLACK_WEBHOOK_URL: optionalString,

  DATA_DIR: optionalString.transform((v) => path.resolve(v ?? "data")),
  KNOWLEDGE_DIR: optionalString.transform((v) => path.resolve(v ?? "knowledge")),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  marmalade: { baseUrl: string; apiKey: string };
  mailboxId: string;
  llm: { provider: "anthropic" | "openai"; model: string };
  unansweredLookbackDays: number;
  learnFromDays: number;
  learnMaxExamples: number;
  longThreadMessages: number;
  dashboardPort: number;
  bulkSendGapSeconds: number;
  mode: "shadow" | "send";
  killSwitch: boolean;
  jelly: { baseUrl: string; team: string; timezone: string; cookie?: string };
  jellyConversationUrl?: string;
  slackWebhookUrl?: string;
  dataDir: string;
  knowledgeDir: string;
  workDir: string;
}

export class ConfigError extends Error {}

export function parseEnv(env: NodeJS.ProcessEnv): Env {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  const parsed = result.data;
  // Register every credential before anything can log it.
  registerSecret(parsed.MARMALADE_API_KEY);
  registerSecret(parsed.ANTHROPIC_API_KEY);
  registerSecret(parsed.OPENAI_API_KEY);
  registerSecret(parsed.JELLY_SESSION_COOKIE);
  registerSecret(parsed.SLACK_WEBHOOK_URL);
  return parsed;
}

export function requireMarmalade(env: Env): { baseUrl: string; apiKey: string } {
  const missing = (["MARMALADE_BASE_URL", "MARMALADE_API_KEY"] as const).filter((k) => !env[k]);
  if (missing.length > 0) throw new ConfigError(`Missing required env: ${missing.join(", ")}`);
  return { baseUrl: env.MARMALADE_BASE_URL!, apiKey: env.MARMALADE_API_KEY! };
}

export function loadConfig(env: NodeJS.ProcessEnv, workDir = process.cwd()): Config {
  const parsed = parseEnv(env);
  const marmalade = requireMarmalade(parsed);
  if (!parsed.MAILBOX_ID) {
    throw new ConfigError("Missing required env: MAILBOX_ID (run `npm run inspect` to list mailboxes)");
  }
  if (parsed.MODE === "send" && !parsed.JELLY_SESSION_COOKIE) {
    throw new ConfigError("MODE=send needs JELLY_SESSION_COOKIE (see the README)");
  }
  const provider = parsed.LLM_PROVIDER ?? (parsed.ANTHROPIC_API_KEY ? "anthropic" : parsed.OPENAI_API_KEY ? "openai" : null);
  if (!provider) throw new ConfigError("Set ANTHROPIC_API_KEY or OPENAI_API_KEY so drafts can be written");
  return {
    marmalade,
    mailboxId: parsed.MAILBOX_ID,
    llm: { provider, model: provider === "openai" ? parsed.OPENAI_MODEL : parsed.ANTHROPIC_MODEL },
    unansweredLookbackDays: parsed.UNANSWERED_LOOKBACK_DAYS,
    learnFromDays: parsed.LEARN_FROM_DAYS,
    learnMaxExamples: parsed.LEARN_MAX_EXAMPLES,
    longThreadMessages: parsed.LONG_THREAD_MESSAGES,
    dashboardPort: parsed.DASHBOARD_PORT,
    bulkSendGapSeconds: parsed.BULK_SEND_GAP_SECONDS,
    mode: parsed.MODE,
    killSwitch: parsed.KILL_SWITCH,
    jelly: {
      baseUrl: parsed.JELLY_BASE_URL,
      team: parsed.JELLY_TEAM,
      timezone: parsed.JELLY_TIMEZONE,
      cookie: parsed.JELLY_SESSION_COOKIE,
    },
    jellyConversationUrl: parsed.JELLY_CONVERSATION_URL,
    slackWebhookUrl: parsed.SLACK_WEBHOOK_URL,
    dataDir: parsed.DATA_DIR,
    knowledgeDir: parsed.KNOWLEDGE_DIR,
    workDir,
  };
}
