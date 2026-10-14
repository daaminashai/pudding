// Fixtures mirror the markup and requests captured from Jelly (with made-up ids and tokens).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeHtmlBody,
  CookieJar,
  JellyClient,
  JellySendError,
  JellySessionError,
  parseConversationPage,
  parseReplyForm,
  sendFields,
  textToHtml,
} from "../src/jelly.js";
import { ConversationChangedError, DraftOpenError, JellySender } from "../src/send.js";
import type { Draft } from "../src/state.js";

const page = (latestPublic = "msg-in-2", extra = "") => `<!doctype html><html><head>
<meta name="csrf-token" content="PAGE_CSRF"></head><body>
<div id="ts_message_100"><form class="message-reply-button-form" method="post" action="/hack-club/drafts/reply?message%5Bconversation_id%5D=55&amp;message%5Bprevious_message_id%5D=msg-in-1"><button data-turbo-frame="message-form-100"></button></form></div>
<div id="ts_message_101"><form class="message-reply-button-form" method="post" action="/hack-club/drafts/reply?message%5Bconversation_id%5D=55&amp;message%5Bprevious_message_id%5D=${latestPublic}"><button data-turbo-frame="message-form-101"></button></form></div>
${extra}
<a href="/hack-club/drafts"><span>Drafts</span></a>
<turbo-frame id="conversation_55"><div id="ts_responder" class="responder"><div class="responder-actions">
<form class="button_to" method="post" action="/hack-club/drafts/reply?message%5Bconversation_id%5D=55&amp;message%5Bprevious_message_id%5D=101"><button data-turbo-frame="message-form-101"></button></form>
</div></div></turbo-frame></body></html>`;

// Shaped like Jelly's real reply box: two empty lines, the signature, then the quote.
const prefill =
  '<br>\n<br>\n<div class="jelly-signature">\n<div><b>Daamin Ashai</b><br></div>\n</div>\n\n<div class="jelly-quote">On Thu … wrote:<blockquote>hi</blockquote></div>';
const draftForm = `<turbo-stream action="update" target="message-form-101"><template>
<form action="/hack-club/conversations/test-thread/messages/msg-draft-1" method="post">
<input type="hidden" name="_method" value="patch" autocomplete="off">
<input type="hidden" name="authenticity_token" value="FORM_TOKEN">
<input type="hidden" name="message[conversation_id]" value="55">
<input type="hidden" name="message[previous_message_id]" value="101">
<input type="hidden" name="message[forwarded]" value="false">
<input type="hidden" name="draft_lock_token" value="LOCK_TOKEN">
<input type="text" name="message[to]" value="Jane &lt;jane@example.com&gt;">
<input type="text" name="message[bcc]" value="jelly-bcc@hackclub.com">
<select name="message[from]"><option value="&quot;Daamin Ashai (Haven)&quot; &lt;haven@hackclub.com&gt;" selected>Haven</option></select>
<input type="text" name="message[subject]" value="Re: Question">
<input type="hidden" name="message[html_body]" value="${prefill.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}">
<input type="hidden" name="quote_reply" value="&lt;div class=&quot;jelly-quote&quot;&gt;q&lt;/div&gt;">
<input type="hidden" name="message[attachments][]" value="">
<input type="file" name="message[attachments][]">
<input type="checkbox" name="archive_conversation" value="true" checked>
<input type="text" name="message[schedule_sending_at]" value="">
<button type="submit" name="button" value="">Send</button>
</form></template></turbo-stream>`;

describe("reading Jelly pages", () => {
  it("finds the CSRF token, ids and the latest message", () => {
    expect(parseConversationPage(page())).toEqual({
      csrfToken: "PAGE_CSRF",
      conversationId: "55",
      replyAction: "/hack-club/drafts/reply?message%5Bconversation_id%5D=55&message%5Bprevious_message_id%5D=101",
      replyFrame: "message-form-101",
      latestId: "101",
      latestPublicId: "msg-in-2",
      drafts: 0,
    });
  });

  it("sees an open draft the way Jelly renders it: a frame loading the draft's edit form", () => {
    const withDraft = page().replace(
      "</div></div></turbo-frame>",
      '<turbo-frame id="message-form-101" src="/hack-club/conversations/test-thread/messages/msg-e9c6e593/edit"></turbo-frame></div></div></turbo-frame>',
    );
    expect(parseConversationPage(withDraft).drafts).toBe(1);
    // Other lazy frames (like notifications) aren't drafts.
    const notDraft = page().replace("<body>", '<body><turbo-frame loading="lazy" id="n" src="/hack-club/my/notifications/popover"></turbo-frame>');
    expect(parseConversationPage(notDraft).drafts).toBe(0);
  });

  it("counts drafts in the thread but not the Drafts nav link", () => {
    expect(parseConversationPage(page("msg-in-2", '<div id="draft_77" class="message draft">wip</div>')).drafts).toBe(1);
  });

  it("treats a sign-in page as a dead session", () => {
    expect(() => parseConversationPage('<form><input type="password" name="p"></form>')).toThrow(JellySessionError);
  });

  it("reads every field of the draft form, in order", () => {
    const form = parseReplyForm(draftForm);
    expect(form.action).toBe("/hack-club/conversations/test-thread/messages/msg-draft-1");
    expect(form.fields.map(([n]) => n)).toEqual([
      "_method",
      "authenticity_token",
      "message[conversation_id]",
      "message[previous_message_id]",
      "message[forwarded]",
      "draft_lock_token",
      "message[to]",
      "message[bcc]",
      "message[from]",
      "message[subject]",
      "message[html_body]",
      "quote_reply",
      "message[attachments][]",
      "archive_conversation",
      "message[schedule_sending_at]",
    ]);
    expect(Object.fromEntries(form.fields)["message[from]"]).toBe('"Daamin Ashai (Haven)" <haven@hackclub.com>');
    expect(Object.fromEntries(form.fields)["message[html_body]"]).toBe(prefill);
  });
});

describe("building the send", () => {
  it("puts the signature on the line right after the reply, with no empty lines between", () => {
    expect(composeHtmlBody("test\n\n\n", prefill)).toBe(
      '<div>test</div><div class="jelly-signature">\n<div><b>Daamin Ashai</b><br></div>\n</div>\n\n<div class="jelly-quote">On Thu … wrote:<blockquote>hi</blockquote></div>',
    );
    // Other shapes of empty lines Jelly could use are dropped too.
    expect(composeHtmlBody("hi", '<div><br></div><p>&nbsp;</p><br/><div class="jelly-signature">sig</div>')).toBe(
      '<div>hi</div><div class="jelly-signature">sig</div>',
    );
  });

  it("leaves one blank line before the quote when there's no signature", () => {
    expect(composeHtmlBody("hi", '<br>\n<br>\n<div class="jelly-quote">On Thu … wrote:</div>')).toBe(
      '<div>hi</div><div><br></div><div class="jelly-quote">On Thu … wrote:</div>',
    );
  });

  it("escapes the reply and keeps blank lines", () => {
    expect(textToHtml("hey <b>you</b> & co\n\nbye")).toBe("<div>hey &lt;b&gt;you&lt;/b&gt; &amp; co</div><div><br></div><div>bye</div>");
  });

  it("sends the form's fields with our body, archive on, no schedule, plain button", () => {
    const fields = Object.fromEntries(sendFields(parseReplyForm(draftForm), "hi jane"));
    expect(fields._method).toBe("patch");
    expect(fields.authenticity_token).toBe("FORM_TOKEN");
    expect(fields.draft_lock_token).toBe("LOCK_TOKEN");
    expect(fields["message[html_body]"]).toMatch(/^<div>hi jane<\/div><div class="jelly-signature">/);
    expect(fields.archive_conversation).toBe("true");
    expect(fields["message[schedule_sending_at]"]).toBe("");
    expect(fields.button).toBe("");
  });
});

describe("CookieJar", () => {
  it("keeps the rotated session cookie", () => {
    const jar = new CookieJar("current_user_session_token=A; _jelly_session=OLD");
    jar.absorb(["_jelly_session=NEW; path=/; secure; HttpOnly", "last_viewed_team_id=2262; path=/"]);
    expect(jar.header()).toBe("current_user_session_token=A; _jelly_session=NEW; last_viewed_team_id=2262");
  });
});

type Step = { status: number; body?: string; location?: string; throws?: Error };

function fakeJelly(steps: Step[]) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(url), headers: init?.headers as Record<string, string>, body: init?.body as string });
    const step = steps.shift();
    if (!step) throw new Error("unexpected request");
    if (step.throws) throw step.throws;
    const headers = new Headers(step.location ? { location: step.location } : {});
    headers.append("set-cookie", "_jelly_session=ROTATED; path=/");
    return new Response(step.body ?? "", { status: step.status, headers });
  }) as typeof fetch;
  const client = new JellyClient({
    baseUrl: "https://app.letsjelly.com",
    team: "hack-club",
    cookie: "current_user_session_token=TOKEN; _jelly_session=SESSION",
    timezone: "Asia/Calcutta",
    fetch: fetchImpl,
  });
  return { client, calls };
}

const draft = { id: 1, conversationId: "test-thread", messageId: "msg-in-2" } as Draft;
const workDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pudding-send-"));

describe("JellySender", () => {
  it("sends exactly like the captured requests", async () => {
    const { client, calls } = fakeJelly([{ status: 200, body: page() }, { status: 200, body: draftForm }, { status: 200 }]);
    const result = await new JellySender(client, { killSwitch: false, workDir: workDir() }).send(draft, "hi jane");
    expect(result).toEqual({ sent: true, message: "sent through Jelly" });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://app.letsjelly.com/hack-club/conversations/test-thread",
      "POST https://app.letsjelly.com/hack-club/drafts/reply?message%5Bconversation_id%5D=55&message%5Bprevious_message_id%5D=101&timezone=Asia%2FCalcutta&include_quote=true",
      "POST https://app.letsjelly.com/hack-club/conversations/test-thread/messages/msg-draft-1",
    ]);
    const [, open, submit] = calls;
    expect(open!.headers["x-csrf-token"]).toBe("PAGE_CSRF");
    expect(open!.headers["turbo-frame"]).toBe("message-form-101");
    expect(open!.body).toBe("authenticity_token=PAGE_CSRF");
    expect(submit!.headers.cookie).toBe("current_user_session_token=TOKEN; _jelly_session=ROTATED");
    const sent = new URLSearchParams(submit!.body);
    expect(sent.get("_method")).toBe("patch");
    expect(sent.get("message[to]")).toBe("Jane <jane@example.com>");
    expect(sent.get("message[html_body]")).toMatch(/^<div>hi jane<\/div>/);
  });

  it("doesn't send when the conversation moved on, and touches nothing in Jelly", async () => {
    const { client, calls } = fakeJelly([{ status: 200, body: page("msg-someone-replied") }]);
    const err = await new JellySender(client, { killSwitch: false, workDir: workDir() }).send(draft, "hi").catch((e) => e);
    expect(err).toBeInstanceOf(ConversationChangedError);
    expect(calls).toHaveLength(1);
  });

  it("doesn't send when someone has a draft open", async () => {
    const { client, calls } = fakeJelly([{ status: 200, body: page("msg-in-2", '<div id="draft_9" class="draft"></div>') }]);
    const err = await new JellySender(client, { killSwitch: false, workDir: workDir() }).send(draft, "hi").catch((e) => e);
    expect(err).toBeInstanceOf(DraftOpenError);
    expect(err.message).toMatch(/unsent draft/);
    expect(calls).toHaveLength(1);
  });

  it("stops before the send step if the STOP file appears", async () => {
    const dir = workDir();
    const { client, calls } = fakeJelly([{ status: 200, body: page() }, { status: 200, body: draftForm }]);
    const sender = new JellySender(client, { killSwitch: false, workDir: dir });
    const original = client.openReplyDraft.bind(client);
    client.openReplyDraft = async (...args) => {
      const form = await original(...args);
      fs.writeFileSync(path.join(dir, "STOP"), "");
      return form;
    };
    const err = await sender.send(draft, "hi").catch((e) => e);
    expect(err.message).toMatch(/STOP file switched sending off/);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["a redirect to sign in", { status: 302, location: "https://app.letsjelly.com/sign_in" }],
    ["a 401", { status: 401 }],
    ["a CSRF failure", { status: 422 }],
  ])("on %s: stops sending, writes STOP and alerts Slack", async (_, failure) => {
    const dir = workDir();
    const { client } = fakeJelly([failure as Step]);
    const slack: string[] = [];
    const slackFetch = (async (_url: string, init?: RequestInit) => {
      slack.push(String(init?.body));
      return new Response("ok");
    }) as unknown as typeof fetch;
    const sender = new JellySender(client, { killSwitch: false, workDir: dir, slackWebhookUrl: "https://hooks.slack.test/x", fetch: slackFetch });
    await expect(sender.send(draft, "hi")).rejects.toBeInstanceOf(JellySessionError);
    expect(fs.existsSync(path.join(dir, "STOP"))).toBe(true);
    expect(slack[0]).toMatch(/Pudding stopped sending/);
    expect(slack[0]).not.toMatch(/TOKEN|SESSION/);
    expect(sender.unavailableReason()).toMatch(/STOP file/);
  });

  it("treats a timeout on the send step as maybe-sent and never retries", async () => {
    const { client, calls } = fakeJelly([
      { status: 200, body: page() },
      { status: 200, body: draftForm },
      { status: 0, throws: new Error("The operation was aborted due to timeout") },
    ]);
    const err = await new JellySender(client, { killSwitch: false, workDir: workDir() }).send(draft, "hi").catch((e) => e);
    expect(err).toBeInstanceOf(JellySendError);
    expect(err.maybeSent).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("treats a 5xx on the send step as maybe-sent, and a 404 as not sent", async () => {
    for (const [status, maybeSent] of [
      [500, true],
      [404, false],
    ] as const) {
      const { client } = fakeJelly([{ status: 200, body: page() }, { status: 200, body: draftForm }, { status }]);
      const err = await new JellySender(client, { killSwitch: false, workDir: workDir() }).send(draft, "hi").catch((e) => e);
      expect(err.maybeSent).toBe(maybeSent);
    }
  });

  it("copies instead of sending while the kill switch is on", async () => {
    const { client, calls } = fakeJelly([]);
    const sender = new JellySender(client, { killSwitch: true, workDir: workDir() });
    expect(await sender.send(draft, "hi")).toEqual({ sent: false, message: "approved; copy it into Jelly" });
    expect(calls).toHaveLength(0);
  });
});
