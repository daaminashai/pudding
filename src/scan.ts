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
import {
  confirmationText,
  isConfirmationCandidate,
  type ConfirmationCheck,
  type ConfirmationInput,
} from "./confirmations.js";
import { learnFromPastConversations, loadDocs, loadStyle, type Knowledge, type Style } from "./knowledge.js";
import { LlmError, type Drafter } from "./llm.js";
import { log } from "./log.js";
import { MarmaladeError, type ConversationDetail, type MarmaladeClient } from "./marmalade.js";
import { extractHeaders, extractSender } from "./metadata.js";
import { errorMessage } from "./redact.js";
import type { DraftContent, DraftKind, State } from "./state.js";
import { CLOSING_LINE, latestMessage, messageText, messageTime, stripQuoted, toThread, type Thread } from "./thread.js";

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
  phase: "listing" | "drafting" | "done";
  message: string;
  /** Conversations with new activity since they were last checked. */
  conversations: number;
  /** Open conversations with nothing new, which weren't fetched again. */
  unchanged: number;
  processed: number;
  drafted: number;
  skipped: number;
  errors: string[];
}

/** Knowledge is only loaded once something actually needs drafting. */
export type KnowledgeSource = () => Promise<Knowledge>;

/** Loading the docs or past replies failed, so nothing can be drafted this run. */
class KnowledgeError extends Error {}

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

/**
 * The reply as it goes in the box: trimmed, and without a closing line the
 * model added anyway, since Jelly puts the sender's signature right below it.
 */
export function finishReply(reply: string): string {
  const lines = reply.trim().split(/\r?\n/);
  const last = (n: number) => lines[lines.length - n]?.trim() ?? "";
  if (lines.length > 2 && CLOSING_LINE.test(last(2)) && last(1).length <= 40 && !/[.?!:]$/.test(last(1))) {
    lines.splice(-2); // "Cheers,\nDaamin"
  } else if (lines.length > 1 && CLOSING_LINE.test(last(1))) {
    lines.splice(-1);
  }
  return lines.join("\n").trim();
}

/**
 * Finds open conversations with new activity since the last scan and drafts a
 * reply for each one whose latest message is inbound and hasn't been drafted or
 * skipped yet. Conversations with nothing new aren't fetched again, and the
 * docs and past replies are only loaded if something needs drafting. Sends nothing.
 */
export async function scan(
  deps: ScanDeps,
  onProgress: (p: ScanProgress) => void = () => {},
): Promise<{ knowledge: Knowledge | null; progress: ScanProgress; names: Map<string, string> }> {
  const { config, marmalade, state } = deps;
  const progress: ScanProgress = {
    phase: "listing",
    message: "Looking for new emails…",
    conversations: 0,
    unchanged: 0,
    processed: 0,
    drafted: 0,
    skipped: 0,
    errors: [],
  };
  const report = (patch: Partial<ScanProgress>) => {
    Object.assign(progress, patch);
    onProgress({ ...progress, errors: [...progress.errors] });
  };
  report({});
  // A fatal model error (no credits, bad key) stops the scan here: nothing else would work either.
  await sortOldConfirmations(deps, (message) => report({ message }));
  report({ message: "Looking for new emails…" });

  // startDate filters on when a conversation was created, which would miss new
  // replies in old threads, so list every open conversation and filter here.
  const list = await marmalade.listConversations(config.mailboxId, {
    status: "open",
    sortBy: "lastMessageAt",
    sortOrder: "desc",
  });
  const cutoff = Date.now() - config.unansweredLookbackDays * 24 * 3600_000;
  const recent = list.filter((l) => Date.parse(l.conversation.lastMessageAt) >= cutoff);
  const activity = new Map<string, string>();
  for (const { conversation } of recent) {
    const at = normalizeTime(conversation.lastMessageAt);
    const prev = activity.get(conversation.id);
    if (prev === undefined || at > prev) activity.set(conversation.id, at);
  }
  const ids = uniqueIds(recent)
    .reverse() // oldest first
    .filter((id) => state.lastChecked(id) !== activity.get(id));
  const unchanged = activity.size - ids.length;
  if (ids.length === 0) {
    report({ phase: "done", unchanged, message: "No new emails since the last check." });
    return { knowledge: null, progress, names: new Map() };
  }
  report({
    phase: "drafting",
    conversations: ids.length,
    unchanged,
    message: `Checking ${ids.length} conversation(s) with new activity…`,
  });

  let knowledge: Promise<Knowledge> | null = null;
  const getKnowledge: KnowledgeSource = () =>
    (knowledge ??= buildKnowledge(deps, (message) => report({ message })).catch((err) => {
      throw new KnowledgeError(`couldn't load the docs and past replies: ${errorMessage(err)}`);
    }));

  let fatal: Error | null = null;
  const names = await memberNames(marmalade);
  await pool(ids, CONCURRENCY, async (conversationId) => {
    if (fatal) return;
    try {
      const outcome = await processConversation(deps, getKnowledge, conversationId, { names });
      if (outcome === "drafted") progress.drafted++;
      if (outcome === "skipped") progress.skipped++;
    } catch (err) {
      if ((err instanceof LlmError && err.fatal) || err instanceof KnowledgeError) {
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

  const stopped = fatal as Error | null; // set inside the workers, which TypeScript can't see
  if (stopped) {
    // Drafts written so far are saved; the dashboard shows this as the run's error.
    const message = `Stopped after ${progress.drafted} new draft(s): ${stopped.message}`;
    throw stopped instanceof LlmError ? new LlmError(message, false, true) : new Error(message);
  }
  report({
    phase: "done",
    message: `Done: ${progress.drafted} new draft(s), ${progress.skipped} skipped, ${progress.errors.length} error(s).`,
  });
  return { knowledge: knowledge ? await knowledge : null, progress, names };
}

type Outcome = "drafted" | "skipped" | "seen" | "answered" | "empty";

/** Marmalade's list can repeat a conversation (identical rows); keep the first of each. */
export function uniqueIds(rows: Array<{ conversation: { id: string } }>): string[] {
  return [...new Set(rows.map((r) => r.conversation.id))];
}

/**
 * Drafts the latest inbound message in one conversation, or records why not,
 * then remembers the conversation as checked. `force` (the dashboard's "Draft
 * anyway") skips the skip checks and asks the drafter for a reply even if it
 * would say none is needed.
 */
export async function processConversation(
  deps: ScanDeps,
  knowledge: KnowledgeSource,
  conversationId: string,
  options: { force?: boolean; names?: Map<string, string> } = {},
): Promise<Outcome> {
  const conversation = await deps.marmalade.getConversation(deps.config.mailboxId, conversationId);
  const outcome = await handleConversation(deps, knowledge, conversation, options);
  // Only once it's fully handled: anything that threw gets another go next scan. And
  // only if the newest message is here: if lastMessageAt is ahead of the messages
  // Marmalade returned, one may not have synced yet, so look again next scan.
  const newest = Math.max(0, ...conversation.messages.map((m) => Math.max(messageTime(m), Date.parse(m.createdAt) || 0)));
  if (conversation.messages.length === 0 || Date.parse(conversation.lastMessageAt) - newest <= 60_000) {
    deps.state.markChecked(conversation.id, normalizeTime(conversation.lastMessageAt));
  }
  return outcome;
}

async function handleConversation(
  deps: ScanDeps,
  getKnowledge: KnowledgeSource,
  conversation: ConversationDetail,
  { force = false, names = new Map<string, string>() } = {},
): Promise<Outcome> {
  const { config, marmalade, state, drafter } = deps;
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
  const insert = (c: DraftContent & { kind?: DraftKind }): Outcome => {
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
      ...c,
    });
    return "drafted";
  };

  let content: DraftContent;
  const confirmation = force ? null : await checkConfirmation(drafter, { subject, thread: thread.entries, question });
  if (confirmation?.onlyConfirmation) {
    return insert({ kind: "confirmation", ...confirmationContent(loadStyle(config.knowledgeDir), confirmation.reason, flags) });
  }

  const knowledge = await getKnowledge();
  try {
    const result = await drafter.draft({ thread, knowledge, senderName: sender.name, forceReply: force });
    if (result.leaveForPerson) return skip(`left for you in Jelly: ${result.note || "the docs say a person handles these"}`);
    if (!result.replyNeeded) return skip(`no reply needed: ${result.note || "the drafter judged it doesn't need one"}`);
    content = {
      draft: finishReply(result.reply),
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

  return insert(content);
}

/**
 * For a reply to the sign-up confirmation email, asks the model (a small call,
 * without the docs) whether it only confirms. Null when it isn't one, or when
 * the check failed in a way that a normal draft can cover.
 */
export async function checkConfirmation(drafter: Drafter, input: ConfirmationInput): Promise<ConfirmationCheck | null> {
  if (!isConfirmationCandidate(input)) return null;
  try {
    return await drafter.checkConfirmation(input.subject, confirmationText(input.thread));
  } catch (err) {
    if (err instanceof LlmError && (err.transient || err.fatal)) throw err;
    log.warn("couldn't check a confirmation reply; drafting it normally", { error: errorMessage(err) });
    return null;
  }
}

export function confirmationContent(style: Style, reason: string, flags: Flag[]): DraftContent {
  return {
    draft: style.confirmationReply.trim(),
    confidence: 1,
    needsHuman: false,
    note: reason,
    flags: flags.filter((f) => !CONTENT_FLAG_KINDS.has(f.kind)),
  };
}

/**
 * Drafts written before confirmations were told apart: moves the ones that only
 * confirm a sign-up to the Confirmations tab, once each.
 */
async function sortOldConfirmations(deps: ScanDeps, report: (message: string) => void): Promise<void> {
  const { state, drafter, config } = deps;
  const unchecked = state.uncheckedPendingReplies();
  if (unchecked.length === 0) return;
  report(`Looking for sign-up confirmations among ${unchecked.length} waiting drafts…`);
  const style = loadStyle(config.knowledgeDir);
  let moved = 0;
  let fatal: LlmError | null = null;
  await pool(unchecked, CONCURRENCY, async (draft) => {
    if (fatal) return;
    try {
      const input = { subject: draft.subject, thread: draft.thread, question: draft.question };
      const check = await checkConfirmation(drafter, input);
      if (check?.onlyConfirmation) {
        state.updateDraft(draft.id, confirmationContent(style, check.reason, draft.flags));
        state.setKind(draft.id, "confirmation");
        moved++;
      }
      state.markConfirmationChecked(draft.id);
    } catch (err) {
      // Left unchecked, so it's tried again next scan.
      if (err instanceof LlmError && err.fatal) fatal ??= err;
      else log.warn("couldn't check a waiting draft for a confirmation", { draftId: draft.id, error: errorMessage(err) });
    }
  });
  if (moved > 0) log.info(`moved ${moved} sign-up confirmation(s) to the Confirmations tab`);
  if (fatal) throw fatal;
}

/** Marmalade doesn't always include a link, so build one from JELLY_CONVERSATION_URL (with {id}). */
export function jellyUrl(template: string | undefined, conversationId: string): string | null {
  return template ? template.replace("{id}", encodeURIComponent(conversationId)) : null;
}

/** Marmalade timestamps, compared as text, so they need one format. */
function normalizeTime(value: string): string {
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString();
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
