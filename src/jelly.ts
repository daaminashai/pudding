// Sends a reply the way Jelly's web app does, using your session cookie. Built
// from requests captured in DevTools:
//   1. POST /{team}/drafts/reply?message[conversation_id]=…&message[previous_message_id]=…&timezone=…&include_quote=true
//      opens a reply draft and returns its form (to/from/subject/signature/quote already filled in).
//   2. POST (_method=patch) /{team}/conversations/{slug}/messages/{draft id} with that form sends it.
// Nothing here retries: a request that might have sent an email is never repeated.
import { parse, type HTMLElement } from "node-html-parser";
import { redact } from "./redact.js";

/** The session is dead (logged out, expired, or CSRF rejected). Sending must stop. */
export class JellySessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JellySessionError";
  }
}

export class JellySendError extends Error {
  constructor(
    message: string,
    /** True when the email may have gone out; it must then be treated as sent. */
    readonly maybeSent: boolean,
    /** The HTTP status, when Jelly answered with an error. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "JellySendError";
  }
}

/** Keeps the cookie header current: Jelly rotates `_jelly_session` on every response. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(header: string) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) this.cookies.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(setCookies: string[]): void {
    for (const line of setCookies) {
      const [pair = "", ...attrs] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || pair.slice(idx + 1).trim() === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(idx + 1).trim());
    }
  }
}

export interface ConversationPage {
  csrfToken: string;
  conversationId: string;
  /** The main Reply button's form action; it always replies to the latest message. */
  replyAction: string;
  replyFrame: string;
  /** Jelly's internal id for the latest message, and its public msg-… id if shown. */
  latestId: string;
  latestPublicId: string | null;
  /** Unsent drafts visible in the conversation. */
  drafts: number;
}

const LOGIN_PAGE = /<input[^>]+type="password"/i;

export function parseConversationPage(html: string): ConversationPage {
  if (LOGIN_PAGE.test(html)) throw new JellySessionError("Jelly showed a sign-in page");
  const root = parse(html);
  const csrfToken = root.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
  const responder = root.querySelector("#ts_responder form.button_to");
  const replyAction = responder?.getAttribute("action");
  const replyFrame = responder?.querySelector("button")?.getAttribute("data-turbo-frame");
  if (!csrfToken || !replyAction || !replyFrame) {
    throw new JellySendError("couldn't find the reply button or CSRF token on the conversation page", false);
  }
  const query = new URL(replyAction, "https://jelly.invalid").searchParams;
  const conversationId = query.get("message[conversation_id]");
  const latestId = query.get("message[previous_message_id]");
  if (!conversationId || !latestId) throw new JellySendError("the reply button has no conversation/message ids", false);

  // Each message's own reply form links its public msg-… id to the internal id via the frame name.
  let latestPublicId: string | null = latestId.startsWith("msg-") ? latestId : null;
  for (const form of root.querySelectorAll("form.message-reply-button-form")) {
    const frame = form.querySelector("button")?.getAttribute("data-turbo-frame");
    const publicId = new URL(form.getAttribute("action") ?? "", "https://jelly.invalid").searchParams.get(
      "message[previous_message_id]",
    );
    if (frame === `message-form-${latestId}` && publicId) latestPublicId = publicId;
  }
  return { csrfToken, conversationId, replyAction, replyFrame, latestId, latestPublicId, drafts: countDrafts(root) };
}

/**
 * Unsent drafts in the conversation. An open draft shows up as a lazy frame that
 * loads its edit form: <turbo-frame id="message-form-…" src="…/messages/msg-…/edit">.
 * Anything else marked as a draft counts too, to stay on the safe side.
 */
function countDrafts(root: HTMLElement): number {
  let n = root
    .querySelectorAll("turbo-frame[src]")
    .filter((f) => /\/messages\/[^/]+\/edit(\?|$)/.test(f.getAttribute("src") ?? "")).length;
  for (const el of root.querySelectorAll("[class], [id]")) {
    const cls = el.getAttribute("class") ?? "";
    const id = el.getAttribute("id") ?? "";
    if (/(^|[\s_-])draft($|[\s_-])/i.test(cls) || /^draft[_-]/i.test(id)) n++;
  }
  return n;
}

export interface ReplyForm {
  action: string;
  fields: Array<[string, string]>;
}

/** Pulls the draft form (action plus every field, in order) out of Jelly's turbo-stream response. */
export function parseReplyForm(html: string): ReplyForm {
  if (LOGIN_PAGE.test(html)) throw new JellySessionError("Jelly showed a sign-in page");
  const root = parse(html);
  const form = root
    .querySelectorAll("form")
    .find((f) => /\/conversations\/[^/]+\/messages\/[^/?#]+/.test(f.getAttribute("action") ?? ""));
  if (!form) throw new JellySendError("Jelly's reply draft didn't contain a message form", false);

  const fields: Array<[string, string]> = [];
  for (const el of form.querySelectorAll("input, textarea, select")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (tag === "input" && ["submit", "button", "file", "image", "reset"].includes(type)) continue;
    if (tag === "input" && (type === "checkbox" || type === "radio") && !el.hasAttribute("checked")) continue;
    if (tag === "textarea") fields.push([name, el.text]);
    else if (tag === "select") {
      const option = el.querySelector("option[selected]") ?? el.querySelector("option");
      fields.push([name, option?.getAttribute("value") ?? option?.text ?? ""]);
    } else fields.push([name, el.getAttribute("value") ?? ""]);
  }
  return { action: form.getAttribute("action")!, fields };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text to the editor's markup: one <div> per line, <div><br></div> for blank lines. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? "<div><br></div>" : `<div>${escapeHtml(line)}</div>`))
    .join("");
}

// Jelly's box starts with empty lines for typing in ("<br>\n<br>\n" above the
// signature in real sends); any mix of these is dropped.
const LEADING_BLANK = /^(?:\s|&nbsp;|<br\s*\/?>|<(div|p)>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>)+/i;

/**
 * The reply goes above whatever Jelly pre-filled, with the sender's signature
 * on the very next line. With no signature, one blank line separates the
 * reply from the quoted email.
 */
export function composeHtmlBody(reply: string, prefilled: string): string {
  const rest = prefilled.replace(LEADING_BLANK, "");
  const gap = rest === "" || /^<div[^>]*\bjelly-signature\b/i.test(rest) ? "" : "<div><br></div>";
  return `${textToHtml(reply)}${gap}${rest}`;
}

/** The send request's fields: the draft form's own, with our body and the captured defaults. */
export function sendFields(form: ReplyForm, reply: string): Array<[string, string]> {
  const fields = [...form.fields];
  const set = (name: string, value: string) => {
    const i = fields.findIndex(([n]) => n === name);
    if (i === -1) fields.push([name, value]);
    else fields[i] = [name, value];
  };
  if (!fields.some(([n]) => n === "_method")) fields.unshift(["_method", "patch"]);
  const prefilled = fields.find(([n]) => n === "message[html_body]")?.[1] ?? "";
  set("message[html_body]", composeHtmlBody(reply, prefilled));
  // As in the captured send: archive afterwards, send now, plain Send button.
  set("archive_conversation", "true");
  set("message[schedule_sending_at]", "");
  set("button", "");
  return fields;
}

export interface JellyClientOptions {
  baseUrl: string;
  team: string;
  cookie: string;
  timezone: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class JellyClient {
  private readonly jar: CookieJar;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: JellyClientOptions) {
    this.jar = new CookieJar(o.cookie);
    this.fetchImpl = o.fetch ?? fetch;
  }

  conversationUrl(slug: string): string {
    return `${this.o.baseUrl}/${this.o.team}/conversations/${encodeURIComponent(slug)}`;
  }

  async conversationPage(slug: string): Promise<ConversationPage> {
    const res = await this.request("GET", this.conversationUrl(slug), { accept: "text/html" });
    return parseConversationPage(await res.text());
  }

  /** Step 1. Creates a reply draft in Jelly and returns its form. */
  async openReplyDraft(page: ConversationPage, referer: string): Promise<ReplyForm> {
    const url = new URL(page.replyAction, this.o.baseUrl);
    url.searchParams.set("timezone", this.o.timezone);
    url.searchParams.set("include_quote", "true");
    const res = await this.request("POST", url.toString(), {
      csrf: page.csrfToken,
      frame: page.replyFrame,
      referer,
      body: new URLSearchParams({ authenticity_token: page.csrfToken }),
    });
    return parseReplyForm(await res.text());
  }

  /** Step 2. Sends the draft. Any failure after the request leaves may mean it sent. */
  async submitReply(page: ConversationPage, form: ReplyForm, fields: Array<[string, string]>, referer: string) {
    let res: Response;
    try {
      res = await this.request("POST", new URL(form.action, this.o.baseUrl).toString(), {
        csrf: page.csrfToken,
        frame: page.replyFrame,
        referer,
        body: new URLSearchParams(fields),
      });
    } catch (err) {
      // A clear rejection (session/CSRF, or a 4xx) means Jelly didn't take it.
      // Timeouts, dropped connections and 5xx are unknown: assume it sent.
      if (err instanceof JellySessionError) throw err;
      if (err instanceof JellySendError && err.status !== undefined && err.status < 500) {
        throw new JellySendError(`Jelly rejected the send: ${err.message}`, false, err.status);
      }
      throw new JellySendError(`sending may or may not have worked: ${errorText(err)}`, true);
    }
    await res.text().catch(() => "");
  }

  private async request(
    method: "GET" | "POST",
    url: string,
    o: { accept?: string; csrf?: string; frame?: string; referer?: string; body?: URLSearchParams },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: o.accept ?? "text/vnd.turbo-stream.html, text/html, application/xhtml+xml",
      cookie: this.jar.header(),
    };
    if (o.body) headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    if (o.csrf) headers["x-csrf-token"] = o.csrf;
    if (o.frame) headers["turbo-frame"] = o.frame;
    if (o.referer) headers.referer = o.referer;
    if (method === "POST") headers.origin = this.o.baseUrl;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: o.body?.toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new JellySendError(`couldn't reach Jelly: ${errorText(err)}`, false);
    }
    this.jar.absorb(res.headers.getSetCookie?.() ?? []);

    const path = new URL(url).pathname;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      if (/sign_in|log_?in|session/i.test(location) || method === "GET") {
        throw new JellySessionError(`Jelly redirected ${path} to ${location || "another page"}`);
      }
      return res; // a redirect after a POST is how Rails often says "done"
    }
    if (res.status === 401 || res.status === 403) throw new JellySessionError(`Jelly returned ${res.status} for ${path}`);
    if (res.status === 422) throw new JellySessionError(`Jelly rejected the CSRF token (422) for ${path}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JellySendError(`Jelly returned ${res.status} for ${path}: ${redact(text.slice(0, 200))}`, false, res.status);
    }
    return res;
  }
}

function errorText(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
