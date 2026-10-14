// What the drafter knows: the docs in knowledge/ (FAQ, organizer guide…), Q&A
// pairs learned from past conversations where the team replied, and replies a
// person approved in the dashboard. All of it goes into one cached prompt prefix.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ConfigError } from "./config.js";
import { checkHeaders, checkSender } from "./guardrails.js";
import { log } from "./log.js";
import type { ConversationDetail, MarmaladeClient } from "./marmalade.js";
import { extractHeaders, extractSender } from "./metadata.js";
import { errorMessage } from "./redact.js";
import type { State } from "./state.js";
import { messageText, sortedMessages, stripQuoted, stripSignature } from "./thread.js";

export interface KnowledgeDoc {
  name: string;
  text: string;
}

export interface Example {
  subject: string;
  question: string;
  reply: string;
  at: string;
  source: "past" | "approved";
}

export interface Style {
  /** Appended after every reply, if set. Otherwise the drafter signs off like past replies do. */
  signOff: string | null;
  notes: string;
}

export interface Knowledge {
  docs: KnowledgeDoc[];
  examples: Example[];
  style: Style;
}

const DOC_EXTENSIONS = new Set([".md", ".txt"]);
const EXAMPLE_CHARS = 2_500;

export function loadDocs(dir: string): KnowledgeDoc[] {
  if (!fs.existsSync(dir)) return [];
  const docs: KnowledgeDoc[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      // _style.md and other _-prefixed files are configuration, not knowledge.
      else if (DOC_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.startsWith("_")) {
        const text = cleanDoc(fs.readFileSync(full, "utf8"));
        if (text) docs.push({ name: path.relative(dir, full), text });
      }
    }
  };
  walk(dir);
  return docs;
}

export function loadStyle(dir: string): Style {
  const file = path.join(dir, "_style.md");
  if (!fs.existsSync(file)) return { signOff: null, notes: "" };
  const raw = fs.readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { signOff: null, notes: stripComments(raw) };
  const data = YAML.parse(match[1] ?? "") ?? {};
  if (typeof data !== "object" || Array.isArray(data)) throw new ConfigError(`${file}: frontmatter must be a mapping`);
  const signOff = typeof data.sign_off === "string" && data.sign_off.trim() ? data.sign_off.trim() : null;
  return { signOff, notes: stripComments(match[2] ?? "") };
}

/** Each run of inbound messages followed by one of our replies becomes an example. */
export function extractExamples(conversation: ConversationDetail): Example[] {
  const messages = sortedMessages(conversation);
  const examples: Example[] = [];
  for (let i = 0; i < messages.length; i++) {
    const reply = messages[i]!;
    if (reply.isInbound) continue;
    const asked = [];
    for (let j = i - 1; j >= 0 && messages[j]!.isInbound; j--) asked.unshift(messages[j]!);
    if (asked.length === 0) continue;
    // Replies to bounces or newsletters teach nothing useful.
    const first = asked[0]!;
    if (!checkSender(extractSender(first)).pass || !checkHeaders(extractHeaders(first.metadata)).pass) continue;

    const question = clip(asked.map((m) => stripQuoted(messageText(m))).join("\n\n"));
    const answer = clip(stripSignature(stripQuoted(messageText(reply))));
    if (!question || !answer) continue;
    examples.push({
      subject: conversation.subject ?? "",
      question,
      reply: answer,
      at: reply.sentAt ?? reply.createdAt,
      source: "past",
    });
  }
  return examples;
}

export interface LearnOptions {
  mailboxId: string;
  days: number;
  maxExamples: number;
  onProgress?: (fetched: number) => void;
}

/** Keep at most this many copies of the same reply, so one stock answer can't crowd out the rest. */
const MAX_SAME_REPLY = 2;
/** Uncached conversations fetched per run while learning; the rest are picked up on later runs. */
const MAX_FETCHES_PER_RUN = 300;
const FETCH_BATCH = 6;

/**
 * Learns from recent conversations where we replied. Conversation details are
 * cached by updatedAt, so later runs only fetch what changed.
 */
export async function learnFromPastConversations(
  marmalade: Pick<MarmaladeClient, "listConversations" | "getConversation">,
  state: State,
  o: LearnOptions,
): Promise<Example[]> {
  if (o.days === 0 || o.maxExamples === 0) return [];
  const list = await marmalade.listConversations(o.mailboxId, {
    startDate: new Date(Date.now() - o.days * 24 * 3600_000).toISOString(),
    sortBy: "lastMessageAt",
    sortOrder: "desc",
  });
  // The list can repeat a conversation, and its messagesCount is always 0, so
  // neither can be used to pick what to fetch.
  const seen = new Set<string>();
  const conversations = list.map((r) => r.conversation).filter((c) => !seen.has(c.id) && seen.add(c.id));

  const examples: Example[] = [];
  const replyCounts = new Map<string, number>();
  const keep = (e: Example) => {
    const key = e.reply.toLowerCase().replace(/\s+/g, " ").trim();
    const n = replyCounts.get(key) ?? 0;
    if (n >= MAX_SAME_REPLY || examples.length >= o.maxExamples) return;
    replyCounts.set(key, n + 1);
    examples.push(e);
  };

  let fetched = 0;
  for (let i = 0; i < conversations.length && examples.length < o.maxExamples; i += FETCH_BATCH) {
    const batch = conversations.slice(i, i + FETCH_BATCH);
    const results = await Promise.all(
      batch.map(async (conversation) => {
        const cached = state.getLearned(conversation.id);
        if (cached && cached.updatedAt === conversation.updatedAt) return cached.examples;
        if (fetched >= MAX_FETCHES_PER_RUN) return [];
        fetched++;
        try {
          const detail = await marmalade.getConversation(o.mailboxId, conversation.id);
          const learned = extractExamples(detail);
          state.putLearned(conversation.id, conversation.updatedAt, learned);
          return learned;
        } catch (err) {
          log.warn("couldn't learn from conversation", { conversationId: conversation.id, error: errorMessage(err) });
          return [];
        }
      }),
    );
    o.onProgress?.(fetched);
    for (const learned of results) learned.forEach(keep);
  }
  return examples;
}

/** HTML comments are for whoever edits the file, not for the model. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/**
 * Drops comments and embedded images. Google Docs exports inline every image as
 * base64, which can be most of the file and means nothing to the model.
 */
export function cleanDoc(text: string): string {
  return stripComments(
    text
      .replace(/^\[[^\]\n]+\]:\s*<?data:[^\n]*$/gm, "") // [image1]: <data:image/png;base64,…>
      .replace(/!\[[^\]\n]*\]\(\s*<?data:[^)]*\)/g, "") // ![alt](data:image/…)
      .replace(/!\[[^\]\n]*\]\[[^\]\n]*\]/g, "") // ![][image1]
      .replace(/\n{3,}/g, "\n\n"),
  );
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > EXAMPLE_CHARS ? `${trimmed.slice(0, EXAMPLE_CHARS)}…` : trimmed;
}
