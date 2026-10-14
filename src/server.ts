// Local review dashboard. Bound to 127.0.0.1 only. Every /api call needs the
// per-run token embedded in the page, so another website open in the same
// browser can't approve drafts, and the Host check blocks DNS rebinding.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { log } from "./log.js";
import type { Knowledge } from "./knowledge.js";
import { errorMessage } from "./redact.js";
import {
  buildKnowledge,
  CONTENT_FLAG_KINDS,
  contentFlags,
  jellyUrl,
  memberNames,
  processConversation,
  scan,
  withSignOff,
  type ScanDeps,
  type ScanProgress,
} from "./scan.js";
import { JellySendError, JellySessionError } from "./jelly.js";
import { ConversationChangedError, DraftOpenError, type Sender } from "./send.js";
import type { Draft } from "./state.js";
import { latestMessage } from "./thread.js";

export interface DashboardDeps extends ScanDeps {
  sender: Sender;
}

interface ScanStatus {
  running: boolean;
  progress: ScanProgress | null;
  error: string | null;
  finishedAt: string | null;
}

const HTML_FILE = new URL("./dashboard.html", import.meta.url);
const MAX_BODY = 1_000_000;

export class Dashboard {
  readonly token = crypto.randomBytes(24).toString("hex");
  readonly scanStatus: ScanStatus = { running: false, progress: null, error: null, finishedAt: null };
  private knowledge: Knowledge | null = null;
  /** Jelly member id -> name, refreshed each scan, for assignment flags saved with raw ids. */
  private names = new Map<string, string>();
  private scanPromise: Promise<void> | null = null;

  constructor(private readonly deps: DashboardDeps) {}

  /** Starts a scan unless one is already running. Resolves when it finishes. */
  startScan(): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    Object.assign(this.scanStatus, { running: true, error: null, progress: null });
    this.scanPromise = scan(this.deps, (p) => (this.scanStatus.progress = p))
      .then(({ knowledge, progress, names }) => {
        // A scan with nothing new loads neither, so keep what's already known.
        if (knowledge) this.knowledge = knowledge;
        if (names.size > 0) this.names = names;
        log.info(progress.message, { errors: progress.errors.length });
      })
      .catch((err) => {
        this.scanStatus.error = errorMessage(err);
        log.error("scan failed", { error: this.scanStatus.error });
      })
      .finally(() => {
        Object.assign(this.scanStatus, { running: false, finishedAt: new Date().toISOString() });
        this.scanPromise = null;
      });
    return this.scanPromise;
  }

  private async getKnowledge(): Promise<Knowledge> {
    return (this.knowledge ??= await buildKnowledge(this.deps));
  }

  createServer(): http.Server {
    const html = fs.readFileSync(HTML_FILE, "utf8").replace("__TOKEN__", this.token);
    return http.createServer((req, res) => {
      this.handle(req, res, html).catch((err) => {
        log.error("request failed", { url: req.url, error: errorMessage(err) });
        send(res, 500, { error: errorMessage(err) });
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, html: string) {
    const host = req.headers.host ?? "";
    const port = req.socket.localPort;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "bad host" });

    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      return res.end(html);
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
    if (req.headers["x-pudding-token"] !== this.token) return send(res, 403, { error: "bad token" });

    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, this.snapshot());
    if (req.method === "POST" && url.pathname === "/api/scan") {
      void this.startScan();
      return send(res, 202, this.snapshot());
    }

    const skippedMatch = /^\/api\/skipped\/([^/]+)\/draft$/.exec(url.pathname);
    if (req.method === "POST" && skippedMatch) return this.draftAnyway(res, decodeURIComponent(skippedMatch[1]!));

    const match = /^\/api\/drafts\/(\d+)\/(approve|discard|redo)$/.exec(url.pathname);
    if (req.method === "POST" && match) {
      const id = Number(match[1]);
      const body = await readJson(req);
      if (match[2] === "approve") return this.approve(res, id, body);
      if (match[2] === "discard") return this.discard(res, id);
      return this.redo(res, id, body);
    }
    return send(res, 404, { error: "not found" });
  }

  private snapshot() {
    const { state, sender, config } = this.deps;
    // Drafts saved before the link setting or name lookup existed get both filled in here.
    const withLink = (d: Draft): Draft => ({
      ...d,
      conversationUrl: d.conversationUrl ?? jellyUrl(config.jellyConversationUrl, d.conversationId),
      flags: d.flags.map((f) =>
        f.kind === "assigned" ? { ...f, detail: f.detail.replace(/\b\d+\b/g, (id) => this.names.get(id) ?? id) } : f,
      ),
    });
    return {
      drafts: state.pendingDrafts().map(withLink),
      done: state.decidedDrafts(50).map(withLink),
      skipped: state.recentSkipped(50),
      scan: this.scanStatus,
      sending: { reasonUnavailable: sender.unavailableReason() },
    };
  }

  private async approve(res: http.ServerResponse, id: number, body: Record<string, unknown>) {
    const { state, marmalade, config, sender } = this.deps;
    const draft = state.getDraft(id);
    if (!draft || draft.status !== "pending") return send(res, 404, { error: "no pending draft with that id" });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return send(res, 400, { error: "the reply is empty" });

    // The mirror lags, so this catches most but not all races; the Jelly send
    // flow will re-check against Jelly itself before sending.
    let warning: string | null = null;
    try {
      const conversation = await marmalade.getConversation(config.mailboxId, draft.conversationId);
      const latest = latestMessage(conversation);
      if (latest && latest.id !== draft.messageId) {
        const reason = latest.isInbound ? "a newer message arrived" : "someone already replied in Jelly";
        state.setStatus(id, "stale", reason);
        return send(res, 409, { error: `Not approved: ${reason}. Scan again to get a fresh draft.` });
      }
    } catch (err) {
      if (sender.unavailableReason() === null) {
        return send(res, 502, { error: `Couldn't confirm the conversation is unchanged: ${errorMessage(err)}` });
      }
      warning = `Couldn't double-check the conversation first (${errorMessage(err)}); check Jelly before pasting.`;
    }

    const url = draft.conversationUrl ?? jellyUrl(config.jellyConversationUrl, draft.conversationId);
    let result;
    try {
      result = await sender.send(draft, text);
    } catch (err) {
      const message = errorMessage(err);
      if (err instanceof JellySendError && err.maybeSent) {
        // Never risk a second copy: treat it as sent and say so loudly.
        state.setStatus(id, "sent", `may have been sent: ${message}`, text);
        log.error("send outcome unknown; marked as sent", { draftId: id, error: message });
        return send(res, 200, {
          status: "sent",
          text,
          url,
          warning: `It's unclear whether this went out (${message}). Check the conversation in Jelly before doing anything else.`,
        });
      }
      if (err instanceof DraftOpenError) {
        // Leave the draft in the queue: approve again once the other draft is sent or deleted.
        return send(res, 409, { error: `${message}. Approve again once it's sent or deleted.` });
      }
      if (err instanceof ConversationChangedError) {
        state.setStatus(id, "stale", message);
        return send(res, 409, { error: `${message}. Check inbox again to get a fresh draft.` });
      }
      if (err instanceof JellySessionError) {
        return send(res, 503, {
          error: `Not sent: the Jelly login stopped working (${message}). Sending is off until it's reconnected; see the README.`,
        });
      }
      return send(res, 502, { error: message.startsWith("Not sent") ? message : `Not sent: ${message}` });
    }
    state.setStatus(id, result.sent ? "sent" : "approved", result.message, text);
    return send(res, 200, { status: result.sent ? "sent" : "approved", text, warning, url });
  }

  /** "Draft anyway" on a skipped email: forget the skip and draft it, skip checks off. */
  private async draftAnyway(res: http.ServerResponse, messageId: string) {
    const { state } = this.deps;
    const skipped = state.getSkipped(messageId);
    if (!skipped) return send(res, 404, { error: "no skipped email with that id" });
    state.removeSkipped(messageId);
    try {
      const names = await memberNames(this.deps.marmalade);
      const outcome = await processConversation(this.deps, () => this.getKnowledge(), skipped.conversationId, {
        force: true,
        names,
      });
      return send(res, 200, { outcome });
    } catch (err) {
      state.addSkipped(skipped);
      return send(res, 502, { error: `Couldn't draft it: ${errorMessage(err)}` });
    }
  }

  private discard(res: http.ServerResponse, id: number) {
    const draft = this.deps.state.getDraft(id);
    if (!draft || draft.status !== "pending") return send(res, 404, { error: "no pending draft with that id" });
    this.deps.state.setStatus(id, "discarded", "discarded in dashboard");
    return send(res, 200, { status: "discarded" });
  }

  private async redo(res: http.ServerResponse, id: number, body: Record<string, unknown>) {
    const { state, drafter } = this.deps;
    const draft = state.getDraft(id);
    if (!draft || draft.status !== "pending") return send(res, 404, { error: "no pending draft with that id" });
    const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
    const current = typeof body.text === "string" ? body.text : draft.draft;

    const knowledge = await this.getKnowledge();
    const thread = { subject: draft.subject, entries: draft.thread };
    const result = await drafter.draft({
      thread,
      knowledge,
      senderName: draft.senderName,
      revise: instructions ? { previousDraft: current, instructions } : undefined,
    });
    const content = {
      draft: withSignOff(result.reply, knowledge.style),
      confidence: result.confidence,
      needsHuman: result.needsHuman,
      note: result.note,
      flags: [
        ...draft.flags.filter((f) => !CONTENT_FLAG_KINDS.has(f.kind)),
        ...contentFlags(result.reply, knowledge, thread, draft.senderName),
      ],
    };
    state.updateDraft(id, content);
    return send(res, 200, state.getDraft(id));
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
}
