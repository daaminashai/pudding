import type { Config } from "./config.js";
import { findUngrounded } from "./grounding.js";
import {
  assignmentFlag,
  attachmentFlag,
  failedChecks,
  skipChecks,
  summarizeFailures,
  threadLengthFlag,
  type Flag,
} from "./guardrails.js";
import { findAiTells } from "./humanize.js";
import { learnFromPastConversations, loadDocs, loadStyle, type Knowledge, type Style } from "./knowledge.js";
import { LlmError, type Drafter } from "./llm.js";
import { log } from "./log.js";
import { MarmaladeError, type MarmaladeClient } from "./marmalade.js";
import { extractHeaders, extractSender } from "./metadata.js";
import { errorMessage } from "./redact.js";
import type { State } from "./state.js";
import { latestMessage, messageText, stripQuoted, toThread, type Thread } from "./thread.js";

export interface ScanDeps {
  config: Pick<
    Config,
    | "mailboxId"
    | "unansweredLookbackDays"
    | "learnFromDays"
    | "learnMaxExamples"
    | "longThreadMessages"
    | "knowledgeDir"
    | "jellyConversationUrl"
  >;
  marmalade: Pick<MarmaladeClient, "listConversations" | "getConversation" | "getAssignment" | "listMembers">;
  drafter: Drafter;
  state: State;
}

/** Jelly member id -> name. Best effort: without it, assignments show the raw id. */
export async function memberNames(marmalade: ScanDeps["marmalade"]): Promise<Map<string, string>> {
  try {
    const members = await marmalade.listMembers();
    return new Map(members.flatMap((m) => (m.jelly ? [[m.jelly.id, m.jelly.name ?? m.jelly.email] as const] : [])));
  } catch (err) {
    log.warn("couldn't load team members", { error: errorMessage(err) });
    return new Map();
  }
}

export interface ScanProgress {
  phase: "learning" | "listing" | "drafting" | "done";
  message: string;
  conversations: number;
  processed: number;
  drafted: number;
  skipped: number;
  errors: string[];
}

/** Approved replies kept as examples, on top of the ones learned from history. */
const APPROVED_EXAMPLES = 40;
const CONCURRENCY = 3;

// Flags recomputed whenever the draft text changes.
export const CONTENT_FLAG_KINDS = new Set(["unverified", "ai_style"]);

export async function buildKnowledge(deps: ScanDeps, onProgress?: (message: string) => void): Promise<Knowledge> {
  const { config, state, marmalade } = deps;
  const docs = loadDocs(config.knowledgeDir);
  const style = loadStyle(config.knowledgeDir);
  onProgress?.("Learning from past replies…");
  const past = await learnFromPastConversations(marmalade, state, {
    mailboxId: config.mailboxId,
    days: config.learnFromDays,
    maxExamples: config.learnMaxExamples,
    onProgress: (n) => onProgress?.(`Learning from past replies… (${n} conversations read)`),
  });
  // Approved replies go last, closest to the email being answered.
  const examples = [...past, ...state.approvedExamples(APPROVED_EXAMPLES).reverse()];
  return { docs, style, examples };
}

/** Flags about the text itself: facts not found in any source, and AI-style writing. */
export function contentFlags(reply: string, knowledge: Knowledge, thread: Thread, senderName: string | null): Flag[] {
  const flags: Flag[] = [];
  const sources = [
    ...knowledge.docs.map((d) => d.text),
    ...knowledge.examples.flatMap((e) => [e.question, e.reply]),
    ...thread.entries.map((e) => e.text),
    thread.subject,
    senderName ?? "",
  ];
  const ungrounded = findUngrounded(reply, sources);
  if (ungrounded.length > 0) {
    flags.push({ kind: "unverified", detail: `not in the docs, past replies or thread: ${ungrounded.join(", ")}` });
  }
  const tells = findAiTells(reply);
  if (tells.length > 0) flags.push({ kind: "ai_style", detail: tells.join(", ") });
  return flags;
}

export function withSignOff(reply: string, style: Style): string {
  if (!reply.trim()) return "";
  return style.signOff ? `${reply.trim()}\n\n${style.signOff}` : reply.trim();
}

/**
 * Finds every open conversation whose latest message is inbound and hasn't been
 * drafted or skipped yet, and writes a draft for each into the queue. Sends nothing.
 */
export async function scan(
  deps: ScanDeps,
  onProgress: (p: ScanProgress) => void = () => {},
): Promise<{ knowledge: Knowledge; progress: ScanProgress }> {
  const { config, marmalade } = deps;
  const progress: ScanProgress = {
    phase: "learning",
    message: "Loading knowledge…",
    conversations: 0,
    processed: 0,
    drafted: 0,
    skipped: 0,
    errors: [],
  };
  const report = (patch: Partial<ScanProgress>) => {
    Object.assign(progress, patch);
    onProgress({ ...progress, errors: [...progress.errors] });
  };

  const knowledge = await buildKnowledge(deps, (message) => report({ message }));

  report({ phase: "listing", message: "Looking for unanswered emails…" });
  // startDate filters on when a conversation was created, which would miss new
  // replies in old threads, so list every open conversation and filter here.
  const list = await marmalade.listConversations(config.mailboxId, {
    status: "open",
    sortBy: "lastMessageAt",
    sortOrder: "desc",
  });
  const cutoff = Date.now() - config.unansweredLookbackDays * 24 * 3600_000;
  const recent = list.filter((l) => Date.parse(l.conversation.lastMessageAt) >= cutoff);
  const ids = uniqueIds(recent).reverse(); // oldest first
  report({ phase: "drafting", conversations: ids.length, message: `Checking ${ids.length} open conversations…` });

  let fatal: LlmError | null = null;
  const names = await memberNames(marmalade);
  await pool(ids, CONCURRENCY, async (conversationId) => {
    if (fatal) return;
    try {
      const outcome = await processConversation(deps, knowledge, conversationId, { names });
      if (outcome === "drafted") progress.drafted++;
      if (outcome === "skipped") progress.skipped++;
    } catch (err) {
      if (err instanceof LlmError && err.fatal) {
        fatal ??= err;
        return;
      }
      const message = errorMessage(err);
      log.error("couldn't process conversation", { conversationId, error: message });
      progress.errors.push(`${conversationId}: ${message}`);
    }
    progress.processed++;
    report({ message: `Checked ${progress.processed} of ${ids.length}…` });
  });

  if (fatal) {
    // Drafts written so far are saved; the dashboard shows this as the run's error.
    throw new LlmError(`Stopped after ${progress.drafted} new draft(s): ${(fatal as LlmError).message}`, false, true);
  }
  report({
    phase: "done",
    message: `Done: ${progress.drafted} new draft(s), ${progress.skipped} skipped, ${progress.errors.length} error(s).`,
  });
  return { knowledge, progress };
}

type Outcome = "drafted" | "skipped" | "seen" | "answered" | "empty";

/** Marmalade's list can repeat a conversation (identical rows); keep the first of each. */
export function uniqueIds(rows: Array<{ conversation: { id: string } }>): string[] {
  return [...new Set(rows.map((r) => r.conversation.id))];
}

/**
 * Drafts the latest inbound message in one conversation, or records why not.
 * `force` (the dashboard's "Draft anyway") skips the skip checks and asks the
 * drafter for a reply even if it would say none is needed.
 */
export async function processConversation(
  deps: ScanDeps,
  knowledge: Knowledge,
  conversationId: string,
  { force = false, names = new Map<string, string>() } = {},
): Promise<Outcome> {
  const { config, marmalade, state, drafter } = deps;
  const conversation = await marmalade.getConversation(config.mailboxId, conversationId);
  const latest = latestMessage(conversation);
  if (!latest) return "empty";
  if (!latest.isInbound) {
    state.staleConversation(conversation.id, "answered in Jelly");
    return "answered";
  }
  if (force ? state.hasDraft(latest.id) : state.hasSeen(latest.id)) return "seen";
  // A new inbound message replaces any older pending draft in the same conversation.
  state.staleConversation(conversation.id, "a newer message arrived", latest.id);

  const sender = extractSender(latest);
  const subject = conversation.subject ?? latest.subject ?? "";
  const question = stripQuoted(messageText(latest));
  const skip = (reason: string): Outcome => {
    state.addSkipped({ messageId: latest.id, conversationId: conversation.id, subject, sender: sender.from, reason });
    return "skipped";
  };
  const checks = skipChecks(sender, extractHeaders(latest.metadata), subject, question);
  if (!force && failedChecks(checks).length > 0) return skip(summarizeFailures(checks));

  const assignments = await marmalade.getAssignment(config.mailboxId, conversation.id);
  const flags = [
    assignmentFlag(assignments, names),
    attachmentFlag(latest),
    threadLengthFlag(conversation, config.longThreadMessages),
  ].filter((f): f is Flag => f !== null);

  const thread = toThread(conversation);
  let content;
  try {
    const result = await drafter.draft({ thread, knowledge, senderName: sender.name, forceReply: force });
    if (!result.replyNeeded) return skip(`no reply needed: ${result.note || "the drafter judged it doesn't need one"}`);
    content = {
      draft: withSignOff(result.reply, knowledge.style),
      confidence: result.confidence,
      needsHuman: result.needsHuman,
      note: result.note,
      flags: [...flags, ...contentFlags(result.reply, knowledge, thread, sender.name)],
    };
  } catch (err) {
    // Transient failures are retried on the next scan; anything else goes in the
    // queue with an empty draft so a person can write it.
    if (err instanceof LlmError && (err.transient || err.fatal)) throw err;
    content = {
      draft: "",
      confidence: 0,
      needsHuman: true,
      note: `Couldn't draft this automatically: ${errorMessage(err)}`,
      flags,
    };
  }

  state.insertDraft({
    conversationId: conversation.id,
    messageId: latest.id,
    subject,
    sender: sender.from,
    senderName: sender.name,
    conversationUrl: conversation.url ?? jellyUrl(config.jellyConversationUrl, conversation.id),
    receivedAt: latest.sentAt ?? latest.createdAt,
    thread: thread.entries,
    question,
    ...content,
  });
  return "drafted";
}

/** Marmalade doesn't always include a link, so build one from JELLY_CONVERSATION_URL (with {id}). */
export function jellyUrl(template: string | undefined, conversationId: string): string | null {
  return template ? template.replace("{id}", encodeURIComponent(conversationId)) : null;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

export function isTransient(err: unknown): boolean {
  return (err instanceof MarmaladeError || err instanceof LlmError) && err.transient;
}
