// `npm run inspect [conversationId]`: one real, read-only look at Marmalade so we
// can see what `metadata` actually contains before trusting the guardrails that
// read it. Writes the full conversation JSON to data/inspect/ (gitignored) and
// prints a structural summary.
import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { parseEnv, requireMarmalade } from "./config.js";
import { MarmaladeClient, type ConversationDetail } from "./marmalade.js";
import { errorMessage, redact } from "./redact.js";

const out = (line = "") => process.stdout.write(`${redact(line)}\n`);

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const client = new MarmaladeClient(requireMarmalade(env));

  // /me only works with a logged-in session on some deployments; mailbox-scoped keys get a 401.
  const me = await client.me().catch(() => null);
  if (me) out(`Authenticated: ${me.user ? `${me.user.name} <${me.user.email}>` : me.message}`);

  if (!env.MAILBOX_ID) {
    const mailboxes = await client.listMailboxes();
    if (mailboxes.length === 0) {
      out("MAILBOX_ID is not set, and this key can't list mailboxes (GET /mailboxes returned []).");
      out("Find the mailbox id in Marmalade (where the key was created) or in the inbox's URL in Jelly,");
      out("then set MAILBOX_ID in .env and run this again.");
      return;
    }
    out("\nMAILBOX_ID is not set. Mailboxes visible to this key:");
    for (const m of mailboxes) {
      out(
        `  ${m.jellyMailbox.jellyMailboxId}  "${m.jellyMailbox.name}"  (jelly #${m.jellyMailbox.id}` +
          `${m.marmaladeMailbox ? `, marmalade #${m.marmaladeMailbox.id}, active=${m.marmaladeMailbox.active}` : ", not in marmalade"})`,
      );
    }
    out("\nSet MAILBOX_ID in .env and run this again.");
    return;
  }
  const mailboxId = env.MAILBOX_ID;

  // Which statuses exist, and which field does startDate filter on?
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const recent = await client.listConversations(mailboxId, {
    startDate: weekAgo,
    sortBy: "lastMessageAt",
    sortOrder: "desc",
  });
  const statuses = new Map<string, number>();
  for (const { conversation: c } of recent) statuses.set(c.status, (statuses.get(c.status) ?? 0) + 1);
  out(`\nConversations with startDate=${weekAgo}: ${recent.length}`);
  out(`  statuses: ${[...statuses].map(([s, n]) => `${s}=${n}`).join(", ") || "(none)"}`);
  for (const field of ["createdAt", "updatedAt", "lastMessageAt"] as const) {
    const before = recent.filter((r) => Date.parse(r.conversation[field]) < Date.parse(weekAgo)).length;
    out(`  ${field} earlier than startDate: ${before}`);
  }
  out("  (the field with 0 above is the one startDate filters on, if any)");

  const open = await client.listConversations(mailboxId, {
    status: "open",
    sortBy: "lastMessageAt",
    sortOrder: "desc",
    startDate: weekAgo,
  });
  out(`\nOpen conversations in the last 7 days: ${open.length}`);
  for (const { conversation: c } of open.slice(0, 10)) {
    out(`  ${c.id}  ${c.lastMessageAt}  msgs=${c.messagesCount}  "${c.subject ?? ""}"`);
  }

  const targetId = process.argv[2] ?? open[0]?.conversation.id ?? recent[0]?.conversation.id;
  if (!targetId) {
    out("\nNo conversation to inspect. Pass an id: npm run inspect -- <conversationId>");
    return;
  }

  const raw = await client.getRaw(
    `/mailboxes/${encodeURIComponent(mailboxId)}/conversations/${encodeURIComponent(targetId)}`,
  );
  const assignment = await client.getRaw(
    `/mailboxes/${encodeURIComponent(mailboxId)}/conversations/${encodeURIComponent(targetId)}/assignment`,
  );
  const dir = path.resolve("data", "inspect");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${targetId}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ conversation: raw, assignment }, null, 2)}\n`);
  out(`\nFull JSON for ${targetId} written to ${path.relative(process.cwd(), file)}`);

  const conversation = raw as ConversationDetail;
  out(`\nConversation fields: ${Object.keys(conversation).join(", ")}`);
  out(`Assignment: ${JSON.stringify(assignment)}`);
  for (const [i, m] of (conversation.messages ?? []).entries()) {
    out(
      `\nmessage[${i}] id=${m.id} inbound=${m.isInbound} senderId=${m.senderId} ` +
        `attachments=${m.attachmentsCount} sentAt=${m.sentAt}`,
    );
    out(`  content: ${m.content === null ? "null" : `${m.content.length} chars`}, ` +
      `contentHtml: ${m.contentHtml === null ? "null" : `${m.contentHtml.length} chars`}`);
    out(`  metadata structure:`);
    for (const line of describe(m.metadata, "    metadata")) out(line);
  }
  for (const [i, c] of (conversation.comments ?? []).entries()) {
    out(`\ncomment[${i}] id=${c.id} authorId=${c.authorId}`);
    for (const line of describe(c.metadata, "    metadata")) out(line);
  }
}

/** Key paths, types, and a short preview of each leaf value. */
function describe(value: unknown, prefix: string, depth = 0): string[] {
  if (depth > 6) return [`${prefix}: …`];
  if (value === null || value === undefined) return [`${prefix}: ${value}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}: []`];
    return [`${prefix}: array(${value.length})`, ...describe(value[0], `${prefix}[0]`, depth + 1)];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${prefix}: {}`];
    return entries.flatMap(([k, v]) => describe(v, `${prefix}.${k}`, depth + 1));
  }
  const text = JSON.stringify(value);
  return [`${prefix}: ${typeof value} ${text.length > 80 ? `${text.slice(0, 77)}…` : text}`];
}

main().catch((err) => {
  process.stderr.write(`${errorMessage(err)}\n`);
  process.exit(1);
});
