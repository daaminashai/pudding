// Local review dashboard. Bound to 127.0.0.1 only. Every /api call needs the
// per-run token embedded in the page, so another website open in the same
// browser can't approve drafts, and the Host check blocks DNS rebinding.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import type { Draft, DraftKind } from "./state.js";
import { latestMessage } from "./thread.js";

export interface DashboardDeps extends ScanDeps {
  sender: Sender;
}

type ApproveOutcome =
  | { ok: true; status: "sent" | "approved"; text: string; url: string | null; warning: string | null }
  /** stopBatch: a bulk run should stop rather than try the next one. */
  | { ok: false; httpStatus: number; error: string; stopBatch: boolean; gone?: boolean };

interface BulkStatus {
  running: boolean;
  total: number;
  processed: number;
  sent: number;
  failed: Array<{ id: number; subject: string; error: string }>;
  stoppedReason: string | null;
  /** The draft being sent right now. */
  current: number | null;
  startedAt: string;
  finishedAt: string | null;
}

const MAX_BULK = 500;

interface ScanStatus {
  running: boolean;
  progress: ScanProgress | null;
  error: string | null;
  finishedAt: string | null;
}

/** Where `vite build` puts the dashboard. */
const WEB_DIR = fileURLToPath(new URL("../dist/web/", import.meta.url));
const TOKEN_PLACEHOLDER = "__PUDDING_TOKEN__";
const MAX_BODY = 1_000_000;
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // Radix and the toast library set inline styles.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export class Dashboard {
  readonly token = crypto.randomBytes(24).toString("hex");
  readonly scanStatus: ScanStatus = { running: false, progress: null, error: null, finishedAt: null };
  private knowledge: Knowledge | null = null;
  /** Jelly member id -> name, refreshed each scan, for assignment flags saved with raw ids. */
  private names = new Map<string, string>();
  private scanPromise: Promise<void> | null = null;

  private bulk: BulkStatus | null = null;
  private bulkStop = false;
  /** Drafts being sent or rewritten right now, and which; nothing else may touch them meanwhile. */
  private readonly busy = new Map<number, "being sent" | "being rewritten">();
  private readonly webDir: string;
  private readonly bulkGapMs: number;

  constructor(
    private readonly deps: DashboardDeps,
    options: { webDir?: string; bulkGapMs?: number } = {},
  ) {
    this.webDir = options.webDir ?? WEB_DIR;
    this.bulkGapMs = options.bulkGapMs ?? 3_000;
  }

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
    return http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error("request failed", { url: req.url, error: errorMessage(err) });
        send(res, 500, { error: errorMessage(err) });
      });
    });
  }

  /** Read on every load, so a rebuild shows up on reload. */
  private page(): string {
    const index = path.join(this.webDir, "index.html");
    if (!fs.existsSync(index)) {
      return "<!doctype html><p>The dashboard hasn't been built. Run <code>npm run build</code>, then reload.</p>";
    }
    return fs.readFileSync(index, "utf8").replace(TOKEN_PLACEHOLDER, this.token);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const host = req.headers.host ?? "";
    const port = req.socket.localPort;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "bad host" });

    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": CSP,
      });
      return res.end(this.page());
    }
    const asset = /^\/assets\/([\w-]+(\.[\w-]+)+)$/.exec(url.pathname);
    if (req.method === "GET" && asset) return this.serveAsset(res, asset[1]!);
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
    if (req.headers["x-pudding-token"] !== this.token) return send(res, 403, { error: "bad token" });

    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, this.snapshot());
    if (req.method === "POST" && url.pathname === "/api/scan") {
      void this.startScan();
      return send(res, 202, this.snapshot());
    }

    if (req.method === "POST" && url.pathname === "/api/confirmations/send") return this.startBulk(res, await readJson(req));
    if (req.method === "POST" && url.pathname === "/api/confirmations/stop") {
      this.bulkStop = true;
      return send(res, 200, this.snapshot());
    }

    const skippedMatch = /^\/api\/skipped\/([^/]+)\/draft$/.exec(url.pathname);
    if (req.method === "POST" && skippedMatch) return this.draftAnyway(res, decodeURIComponent(skippedMatch[1]!));

    const match = /^\/api\/drafts\/(\d+)\/(approve|discard|redo|full)$/.exec(url.pathname);
    if (req.method === "POST" && match) {
      const id = Number(match[1]);
      const body = await readJson(req);
      if (match[2] === "approve") return this.approve(res, id, body);
      if (match[2] === "discard") return this.discard(res, id);
      // "full": a confirmation that needs a real answer after all.
      if (match[2] === "full") return this.redo(res, id, {}, "reply");
      return this.redo(res, id, body);
    }
    return send(res, 404, { error: "not found" });
  }

  /** Built files only: names are checked above, so nothing outside dist/web/assets can be read. */
  private serveAsset(res: http.ServerResponse, name: string) {
    const type = CONTENT_TYPES[path.extname(name)];
    const file = path.join(this.webDir, "assets", name);
    if (!type || !fs.existsSync(file)) return send(res, 404, { error: "not found" });
    res.writeHead(200, {
      "Content-Type": type,
      // Vite puts a content hash in every file name.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(file).pipe(res);
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
      drafts: state.pendingDrafts("reply").map(withLink),
      confirmations: state.pendingDrafts("confirmation").map(withLink),
      done: state.decidedDrafts(50).map(withLink),
      skipped: state.recentSkipped(50),
      scan: this.scanStatus,
      sending: { reasonUnavailable: sender.unavailableReason() },
      bulk: this.bulk,
      bulkGapSeconds: this.bulkGapMs / 1000,
    };
  }

  private async approve(res: http.ServerResponse, id: number, body: Record<string, unknown>) {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return send(res, 400, { error: "the reply is empty" });
    const outcome = await this.approveDraft(id, { text });
    if (!outcome.ok) return send(res, outcome.httpStatus, { error: outcome.error });
    const { ok: _ok, ...result } = outcome;
    return send(res, 200, result);
  }

  /**
   * Checks the conversation hasn't moved on, then sends (or, when sending is
   * off, records) the reply. Shared by the Approve button and bulk sending.
   */
  private async approveDraft(
    id: number,
    o: { text?: string; kind?: DraftKind; bulk?: boolean },
  ): Promise<ApproveOutcome> {
    const { state, marmalade, config, sender } = this.deps;
    // A double click, the same draft in a bulk run and approved by hand, or one being rewritten: only one at a time.
    const busy = this.busy.get(id);
    if (busy) return { ok: false, httpStatus: 409, error: `This draft is ${busy} right now.`, stopBatch: false };
    this.busy.set(id, "being sent");
    try {
      // Read it now, while holding it: it may have been sent, discarded or rewritten since the caller looked.
      const draft = state.getDraft(id);
      if (!draft || draft.status !== "pending" || (o.kind && draft.kind !== o.kind)) {
        return { ok: false, httpStatus: 404, error: "no pending draft with that id", stopBatch: false, gone: true };
      }
      const text = o.text ?? draft.draft;
      // The mirror lags, so this catches most but not all races; the Jelly send
      // flow will re-check against Jelly itself before sending.
      let warning: string | null = null;
      try {
        const conversation = await marmalade.getConversation(config.mailboxId, draft.conversationId);
        const latest = latestMessage(conversation);
        if (latest && latest.id !== draft.messageId) {
          const reason = latest.isInbound ? "a newer message arrived" : "someone already replied in Jelly";
          state.setStatus(id, "stale", reason);
          return { ok: false, httpStatus: 409, error: `Not approved: ${reason}. Scan again to get a fresh draft.`, stopBatch: false };
        }
      } catch (err) {
        if (sender.unavailableReason() === null) {
          return {
            ok: false,
            httpStatus: 502,
            error: `Couldn't confirm the conversation is unchanged: ${errorMessage(err)}`,
            stopBatch: true,
          };
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
          return {
            ok: true,
            status: "sent",
            text,
            url,
            warning: `It's unclear whether this went out (${message}). Check the conversation in Jelly before doing anything else.`,
          };
        }
        if (err instanceof DraftOpenError) {
          // Leave the draft in the queue: approve again once the other draft is sent or deleted.
          return { ok: false, httpStatus: 409, error: `${message}. Approve again once it's sent or deleted.`, stopBatch: false };
        }
        if (err instanceof ConversationChangedError) {
          state.setStatus(id, "stale", message);
          return { ok: false, httpStatus: 409, error: `${message}. Check inbox again to get a fresh draft.`, stopBatch: false };
        }
        if (err instanceof JellySessionError) {
          return {
            ok: false,
            httpStatus: 503,
            error: `Not sent: the Jelly login stopped working (${message}). Sending is off until it's reconnected; see the README.`,
            stopBatch: true,
          };
        }
        if (err instanceof JellySendError && err.status === 429) {
          return {
            ok: false,
            httpStatus: 502,
            error: "Not sent: Jelly is rate-limiting us. Wait a few minutes before sending more.",
            stopBatch: true,
          };
        }
        return { ok: false, httpStatus: 502, error: message.startsWith("Not sent") ? message : `Not sent: ${message}`, stopBatch: true };
      }
      if (!result.sent && o.bulk) {
        // Sending switched off (STOP file, kill switch) after the bulk run checked: leave it queued, unsent.
        return { ok: false, httpStatus: 409, error: "Not sent: sending through Jelly switched off.", stopBatch: true };
      }
      state.setStatus(id, result.sent ? "sent" : "approved", result.message, text);
      return { ok: true, status: result.sent ? "sent" : "approved", text, warning, url };
    } finally {
      this.busy.delete(id);
    }
  }

  /**
   * Sends the fixed reply to each selected confirmation, one at a time with a
   * gap between sends so Jelly isn't hammered. Anything that suggests trouble
   * (login gone, rate limit, an unclear outcome, sending switched off) stops
   * the run; a conversation that changed is just skipped.
   */
  private startBulk(res: http.ServerResponse, body: Record<string, unknown>) {
    const reason = this.deps.sender.unavailableReason();
    if (reason) return send(res, 409, { error: `Bulk sending needs sending through Jelly. ${reason}` });
    if (this.bulk?.running) return send(res, 409, { error: "A bulk send is already running." });
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is number => Number.isInteger(x)) : [];
    if (ids.length === 0) return send(res, 400, { error: "no confirmations selected" });
    if (ids.length > MAX_BULK) return send(res, 400, { error: `send at most ${MAX_BULK} at a time` });

    const unique = [...new Set(ids)];
    this.bulkStop = false;
    this.bulk = {
      running: true,
      total: unique.length,
      processed: 0,
      sent: 0,
      failed: [],
      stoppedReason: null,
      current: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    void this.runBulk(unique).catch((err) => {
      log.error("bulk send failed", { error: errorMessage(err) });
      if (this.bulk) Object.assign(this.bulk, { running: false, current: null, stoppedReason: errorMessage(err) });
    });
    return send(res, 202, this.snapshot());
  }

  private async runBulk(ids: number[]): Promise<void> {
    const bulk = this.bulk!;
    const { state, sender } = this.deps;
    let lastAttempt = 0;
    // Sent, discarded or moved to To review since it was selected: skip it quietly.
    const gone = (id: number) => {
      const draft = state.getDraft(id);
      return !draft || draft.status !== "pending" || draft.kind !== "confirmation";
    };
    for (const id of ids) {
      if (gone(id)) {
        bulk.processed++;
        continue;
      }
      const wait = lastAttempt + this.bulkGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (this.bulkStop) {
        bulk.stoppedReason = "Stopped. The rest weren't sent.";
        break;
      }
      const blocked = sender.unavailableReason();
      if (blocked) {
        bulk.stoppedReason = blocked;
        break;
      }
      bulk.current = id;
      lastAttempt = Date.now();
      // approveDraft re-reads the draft, so a Discard or Full reply during the wait wins.
      const subject = state.getDraft(id)?.subject ?? "";
      const outcome = await this.approveDraft(id, { kind: "confirmation", bulk: true });
      bulk.processed++;
      if (!outcome.ok && outcome.gone) continue;
      if (outcome.ok && outcome.status === "sent") bulk.sent++;
      if (outcome.ok && outcome.warning) {
        bulk.stoppedReason = `Stopped after an unclear send: ${outcome.warning}`;
        break;
      }
      if (outcome.ok && outcome.status !== "sent") {
        bulk.stoppedReason = "Stopped: sending through Jelly switched off.";
        break;
      }
      if (!outcome.ok) {
        bulk.failed.push({ id, subject, error: outcome.error });
        if (outcome.stopBatch) {
          bulk.stoppedReason = `Stopped: ${outcome.error}`;
          break;
        }
      }
    }
    Object.assign(bulk, { running: false, current: null, finishedAt: new Date().toISOString() });
    log.info("bulk send finished", { sent: bulk.sent, failed: bulk.failed.length, stopped: bulk.stoppedReason });
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
    const busy = this.busy.get(id);
    if (busy) return send(res, 409, { error: `This draft is ${busy} right now.` });
    this.deps.state.setStatus(id, "discarded", "discarded in dashboard");
    return send(res, 200, { status: "discarded" });
  }

  /** Rewrites a draft; with `kind`, also moves it (a confirmation that needs a full reply). */
  private async redo(res: http.ServerResponse, id: number, body: Record<string, unknown>, kind?: DraftKind) {
    const { state } = this.deps;
    const draft = state.getDraft(id);
    if (!draft || draft.status !== "pending") return send(res, 404, { error: "no pending draft with that id" });
    const busy = this.busy.get(id);
    if (busy) return send(res, 409, { error: `This draft is ${busy} right now.` });
    // Held for the whole model call, so a bulk run can't send the old text meanwhile.
    this.busy.set(id, "being rewritten");
    try {
      return await this.rewrite(res, draft, body, kind);
    } finally {
      this.busy.delete(id);
    }
  }

  private async rewrite(res: http.ServerResponse, draft: Draft, body: Record<string, unknown>, kind?: DraftKind) {
    const { state, drafter } = this.deps;
    const id = draft.id;
    const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
    const current = typeof body.text === "string" ? body.text : draft.draft;

    const knowledge = await this.getKnowledge();
    const thread = { subject: draft.subject, entries: draft.thread };
    const result = await drafter.draft({
      thread,
      knowledge,
      senderName: draft.senderName,
      revise: instructions ? { previousDraft: current, instructions } : undefined,
      forceReply: kind === "reply" ? true : undefined,
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
    if (kind) state.setKind(id, kind);
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
