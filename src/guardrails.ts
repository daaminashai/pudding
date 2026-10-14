import type { Assignment, ConversationDetail, Message } from "./marmalade.js";
import { headerValues, metadataAttachmentCount, type Headers, type SenderInfo } from "./metadata.js";

// Two kinds of checks. Skip checks decide that an email shouldn't get a reply at
// all (newsletters, bounces, auto-replies), so no draft is written. Flags don't
// stop a draft; they're shown on it in the dashboard so the reviewer knows what
// to look at before approving.

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Flag {
  kind: string;
  detail: string;
}

const pass = (name: string, detail = ""): CheckResult => ({ name, pass: true, detail });
const fail = (name: string, detail: string): CheckResult => ({ name, pass: false, detail });

const AUTOMATED_SENDER = /no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|notification/i;

/** Skip: any address identifying the sender looks automated. Passes when there's no address to check. */
export function checkSender(sender: SenderInfo): CheckResult {
  const automated = sender.all.filter((a) => AUTOMATED_SENDER.test(a));
  if (automated.length > 0) return fail("sender", `automated sender: ${automated.join(", ")}`);
  return pass("sender", sender.from ?? "unknown");
}

/** Skip: Auto-Submitted (other than "no"), Precedence bulk/list/junk, or List-Unsubscribe. */
export function checkHeaders(headers: Headers | null): CheckResult {
  const name = "headers";
  if (headers === null) return pass(name, "no headers in metadata");
  const problems: string[] = [];
  for (const value of headerValues(headers, "auto-submitted")) {
    if (value.trim().toLowerCase() !== "no") problems.push(`Auto-Submitted: ${value}`);
  }
  for (const value of headerValues(headers, "precedence")) {
    if (/^(bulk|list|junk)$/i.test(value.trim())) problems.push(`Precedence: ${value}`);
  }
  if (headerValues(headers, "list-unsubscribe").length > 0) problems.push("List-Unsubscribe present");
  return problems.length > 0 ? fail(name, problems.join("; ")) : pass(name, `${headers.size} headers checked`);
}

const AUTO_SUBJECT =
  /^(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|undeliverable|undelivered mail|delivery status notification|mail delivery (failed|subsystem)|returned mail|delivery (failure|has failed))/i;

/** Skip: auto-replies and bounces by subject, and Gmail emoji reactions. */
export function checkAutomatedContent(subject: string, text: string): CheckResult {
  const name = "automated";
  if (AUTO_SUBJECT.test(subject.trim())) return fail(name, `subject looks automated: "${subject.trim()}"`);
  if (text.length < 400 && /reacted via Gmail/i.test(text)) return fail(name, "Gmail emoji reaction");
  return pass(name);
}

export function skipChecks(sender: SenderInfo, headers: Headers | null, subject: string, text: string): CheckResult[] {
  return [checkSender(sender), checkHeaders(headers), checkAutomatedContent(subject, text)];
}

export function assignmentFlag(assignments: Assignment[], names: Map<string, string> = new Map()): Flag | null {
  if (assignments.length === 0) return null;
  const who = assignments.map((a) => names.get(a.jellyContactId) ?? a.jellyContactId);
  return { kind: "assigned", detail: `assigned to ${who.join(", ")}` };
}

export function attachmentFlag(message: Message): Flag | null {
  const count = Math.max(message.attachmentsCount, metadataAttachmentCount(message.metadata));
  return count > 0 ? { kind: "attachments", detail: `${count} attachment(s) the drafter couldn't see` } : null;
}

export function threadLengthFlag(conversation: ConversationDetail, longAt: number): Flag | null {
  // The mirror can lag, so trust whichever count is higher.
  const count = Math.max(conversation.messages.length, conversation.messagesCount);
  return count >= longAt ? { kind: "long_thread", detail: `${count} messages in thread` } : null;
}

export function failedChecks(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => !r.pass);
}

export function summarizeFailures(results: CheckResult[]): string {
  return failedChecks(results)
    .map((r) => `${r.name}: ${r.detail}`)
    .join("; ");
}
