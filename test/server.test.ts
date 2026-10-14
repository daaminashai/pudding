import fs from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scan } from "../src/scan.js";
import { JellySendError, JellySessionError } from "../src/jelly.js";
import { ConversationChangedError, ManualSender, type Sender } from "../src/send.js";
import { Dashboard } from "../src/server.js";
import type { Draft } from "../src/state.js";
import { conversation, fixtures, message } from "./fixtures.js";
import { knowledgeDir, scanDeps } from "./helpers.js";

let server: Server | undefined;
afterEach(() => server?.close());

/** A stand-in for `vite build` output. */
function webDir(): string {
  const dir = knowledgeDir({ "index.html": '<meta name="pudding-token" content="__PUDDING_TOKEN__">' });
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log('hi')");
  fs.writeFileSync(path.join(dir, "secret.txt"), "not an asset");
  return dir;
}

/** Sends through a pretend Jelly. `fail` can make a given draft's send throw. */
class FakeSender implements Sender {
  sent: Array<{ id: number; text: string; at: number }> = [];
  fail: (draft: Draft) => Error | null = () => null;
  gate: Promise<void> | null = null;
  unavailableReason(): string | null {
    return null;
  }
  async send(draft: Draft, text: string) {
    if (this.gate) await this.gate;
    const err = this.fail(draft);
    if (err) throw err;
    this.sent.push({ id: draft.id, text, at: Date.now() });
    return { sent: true, message: "sent through Jelly" };
  }
}

async function setup(conversations = [fixtures.clean()], sender: Sender = new ManualSender(false, knowledgeDir()), bulkGapMs = 0) {
  const ctx = scanDeps(conversations);
  await scan(ctx.deps);
  const dashboard = new Dashboard({ ...ctx.deps, sender }, { webDir: webDir(), bulkGapMs });
  server = dashboard.createServer();
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-pudding-token": dashboard.token, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const draft = ctx.state.pendingDrafts()[0];
  return { ...ctx, dashboard, port, call, draft: draft! };
}

describe("dashboard API", () => {
  it("serves the page with the session token", async () => {
    const { call, dashboard } = await setup();
    const res = await call("/");
    expect(await res.text()).toContain(`<meta name="pudding-token" content="${dashboard.token}">`);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("serves built assets, and nothing outside the assets folder", async () => {
    const { call } = await setup();
    const js = await call("/assets/index-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe("console.log('hi')");
    expect((await call("/assets/missing-1.js")).status).toBe(404);
    expect((await call("/assets/..%2Fsecret.txt")).status).toBe(404);
    expect((await call("/assets/../secret.txt")).status).toBe(404);
    expect((await call("/secret.txt")).status).toBe(404);
  });

  it("rejects API calls without the token", async () => {
    const { call } = await setup();
    expect((await call("/api/state", undefined, { "x-pudding-token": "nope" })).status).toBe(403);
  });

  it("rejects requests for other hostnames (DNS rebinding)", async () => {
    const { port, dashboard } = await setup();
    // fetch won't let us override Host, so use http.request directly.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/api/state", headers: { host: "evil.example", "x-pudding-token": dashboard.token } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("lists pending drafts and says sending isn't connected", async () => {
    const { call } = await setup();
    const state = await (await call("/api/state")).json();
    expect(state.drafts).toHaveLength(1);
    expect(state.sending.reasonUnavailable).toMatch(/MODE isn't send/);
  });

  it("approves the edited text and remembers it as an example", async () => {
    const { call, draft, state } = await setup();
    const res = await call(`/api/drafts/${draft.id}/approve`, { text: "hey jane! march 3.\n\nsam" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "approved", text: "hey jane! march 3.\n\nsam" });
    expect(state.getDraft(draft.id)).toMatchObject({ status: "approved", finalText: "hey jane! march 3.\n\nsam" });
    expect(state.approvedExamples(5)[0]).toMatchObject({ reply: "hey jane! march 3.\n\nsam" });
  });

  it("refuses to approve an empty reply", async () => {
    const { call, draft } = await setup();
    expect((await call(`/api/drafts/${draft.id}/approve`, { text: "  " })).status).toBe(400);
  });

  it("won't approve once a newer message has arrived", async () => {
    const { call, draft, state, marmalade } = await setup();
    const c = marmalade.conversations[0]!;
    marmalade.conversations[0] = { ...c, messages: [...c.messages, message(c.id, { minutesAgo: 0 })] };
    const res = await call(`/api/drafts/${draft.id}/approve`, { text: "hi" });
    expect(res.status).toBe(409);
    expect(state.getDraft(draft.id)).toMatchObject({ status: "stale", statusReason: "a newer message arrived" });
  });

  it("discards a draft", async () => {
    const { call, draft, state } = await setup();
    expect((await call(`/api/drafts/${draft.id}/discard`, {})).status).toBe(200);
    expect(state.getDraft(draft.id)!.status).toBe("discarded");
    expect(state.pendingDrafts()).toEqual([]);
  });

  it("redrafts with the reviewer's instructions", async () => {
    const { call, draft, drafter } = await setup();
    drafter.respond = (req) => ({
      replyNeeded: true,
      reply: req.revise ? "march 3!" : "unexpected",
      confidence: 0.95,
      needsHuman: false,
      note: "",
    });
    const res = await call(`/api/drafts/${draft.id}/redo`, { instructions: "shorter", text: "a long draft" });
    expect(res.status).toBe(200);
    expect((await res.json()).draft).toBe("march 3!\n\ncheers,\nthe team");
    expect(drafter.calls.at(-1)!.revise).toEqual({ previousDraft: "a long draft", instructions: "shorter" });
  });

  it("drafts a skipped email on request, telling the drafter a reply is wanted", async () => {
    const reaction = conversation({ id: "cnv_react", messages: [{ id: "msg_react", text: "😃 Sam reacted via Gmail <https://x>" }] });
    const { call, state, drafter } = await setup([reaction]);
    expect(state.getSkipped("msg_react")?.reason).toBe("automated: Gmail emoji reaction");
    expect(drafter.calls).toHaveLength(0);

    const res = await call(`/api/skipped/msg_react/draft`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "drafted" });
    expect(drafter.calls.at(-1)!.forceReply).toBe(true);
    expect(state.getSkipped("msg_react")).toBeUndefined();
    expect(state.pendingDrafts().map((d) => d.messageId)).toEqual(["msg_react"]);
  });

  it("returns 404 for an unknown skipped email", async () => {
    const { call } = await setup();
    expect((await call(`/api/skipped/nope/draft`, {})).status).toBe(404);
  });

  it("builds Open in Jelly links when Marmalade has none", async () => {
    const noLink = { ...fixtures.clean(), url: null };
    const { call } = await setup([noLink]);
    const state = await (await call("/api/state")).json();
    expect(state.drafts[0].conversationUrl).toBe("https://jelly.test/conversations/cnv_clean");
  });
});

describe("confirmations", () => {
  const foods = () =>
    ["Bela", "Zahra", "Liam"].map((name, i) =>
      conversation({
        id: `cnv_${name.toLowerCase()}`,
        subject: `Re: ${name}: Haven + Framework 12`,
        messages: [{ id: `msg_${name.toLowerCase()}`, text: ["Pizza", "Momos", "Sinigang"][i]!, minutesAgo: 30 - i }],
      }),
    );

  async function untilDone(call: (path: string) => Promise<Response>) {
    for (let i = 0; i < 200; i++) {
      const state = await (await call("/api/state")).json();
      if (state.bulk && !state.bulk.running) return state;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("bulk send didn't finish");
  }

  it("lists confirmations apart from drafts to review", async () => {
    const { call } = await setup([...foods(), fixtures.clean()]);
    const state = await (await call("/api/state")).json();
    expect(state.confirmations.map((d: Draft) => d.conversationId)).toEqual(["cnv_bela", "cnv_zahra", "cnv_liam"]);
    expect(state.drafts.map((d: Draft) => d.conversationId)).toEqual(["cnv_clean"]);
  });

  it("sends the selected confirmations one at a time, spaced out", async () => {
    const sender = new FakeSender();
    const { call, ctxState } = await setupWith(sender, 40);
    const ids = ctxState.pendingDrafts("confirmation").map((d) => d.id);

    const res = await call("/api/confirmations/send", { ids });
    expect(res.status).toBe(202);
    const state = await untilDone(call);
    expect(state.bulk).toMatchObject({ total: 3, processed: 3, sent: 3, failed: [], stoppedReason: null });
    expect(sender.sent.map((s) => s.text)).toEqual(Array(3).fill("Thanks! Your registration has been confirmed.\n\ncheers,\nthe team"));
    expect(sender.sent[1]!.at - sender.sent[0]!.at).toBeGreaterThanOrEqual(35);
    expect(sender.sent[2]!.at - sender.sent[1]!.at).toBeGreaterThanOrEqual(35);
    expect(ctxState.pendingDrafts("confirmation")).toEqual([]);
    expect(ctxState.decidedDrafts().map((d) => d.status)).toEqual(["sent", "sent", "sent"]);
    // The stock reply doesn't crowd out real examples.
    expect(ctxState.approvedExamples(10)).toEqual([]);
  });

  it("stops the run when the Jelly login dies, and skips a conversation that changed", async () => {
    const sender = new FakeSender();
    sender.fail = (d) =>
      d.conversationId === "cnv_bela"
        ? new ConversationChangedError("Not sent: the conversation changed in Jelly")
        : d.conversationId === "cnv_zahra"
          ? new JellySessionError("Jelly showed a sign-in page")
          : null;
    const { call, ctxState } = await setupWith(sender);
    await call("/api/confirmations/send", { ids: ctxState.pendingDrafts("confirmation").map((d) => d.id) });
    const state = await untilDone(call);
    expect(state.bulk.sent).toBe(0);
    expect(state.bulk.failed.map((f: { subject: string }) => f.subject)).toEqual([
      "Re: Bela: Haven + Framework 12",
      "Re: Zahra: Haven + Framework 12",
    ]);
    expect(state.bulk.stoppedReason).toMatch(/Jelly login stopped working/);
    // Liam's was never tried.
    expect(ctxState.pendingDrafts("confirmation").map((d) => d.conversationId)).toEqual(["cnv_zahra", "cnv_liam"]);
  });

  it("stops when Jelly rate-limits us", async () => {
    const sender = new FakeSender();
    sender.fail = () => new JellySendError("Jelly returned 429 for /x", false, 429);
    const { call, ctxState } = await setupWith(sender);
    await call("/api/confirmations/send", { ids: ctxState.pendingDrafts("confirmation").map((d) => d.id) });
    const state = await untilDone(call);
    expect(state.bulk.processed).toBe(1);
    expect(state.bulk.stoppedReason).toMatch(/rate-limiting/);
  });

  it("can be stopped part way", async () => {
    const sender = new FakeSender();
    const { call, ctxState } = await setupWith(sender, 200);
    await call("/api/confirmations/send", { ids: ctxState.pendingDrafts("confirmation").map((d) => d.id) });
    await new Promise((r) => setTimeout(r, 50));
    await call("/api/confirmations/stop", {});
    const state = await untilDone(call);
    expect(sender.sent).toHaveLength(1);
    expect(state.bulk.stoppedReason).toMatch(/Stopped/);
  });

  it("refuses bulk sending when replies can't be sent through Jelly", async () => {
    const { call, state } = await setup(foods());
    const res = await call("/api/confirmations/send", { ids: state.pendingDrafts("confirmation").map((d) => d.id) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/needs sending through Jelly/);
  });

  it("never sends the same reply twice at once", async () => {
    const sender = new FakeSender();
    let open!: () => void;
    sender.gate = new Promise((r) => (open = r));
    const { call, ctxState } = await setupWith(sender);
    const id = ctxState.pendingDrafts("confirmation")[0]!.id;
    const first = call(`/api/drafts/${id}/approve`, { text: "Thanks!" });
    await new Promise((r) => setTimeout(r, 20));
    const second = await call(`/api/drafts/${id}/approve`, { text: "Thanks!" });
    expect(second.status).toBe(409);
    open();
    expect((await first).status).toBe(200);
    expect(sender.sent).toHaveLength(1);
  });

  it("writes a full reply for a confirmation that needs one", async () => {
    const { call, state, drafter } = await setup(foods());
    const id = state.pendingDrafts("confirmation")[0]!.id;
    const res = await call(`/api/drafts/${id}/full`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "reply", draft: "hey! applications open march 3.\n\ncheers,\nthe team" });
    expect(drafter.calls.at(-1)!.forceReply).toBe(true);
    expect(state.pendingDrafts("reply").map((d) => d.id)).toEqual([id]);
  });

  it("doesn't send one that was discarded while the run waited", async () => {
    const sender = new FakeSender();
    const { call, ctxState } = await setupWith(sender, 150);
    const [first, second, third] = ctxState.pendingDrafts("confirmation").map((d) => d.id);
    await call("/api/confirmations/send", { ids: [first, second, third] });
    await new Promise((r) => setTimeout(r, 50)); // the first is sent; the run is waiting
    expect((await call(`/api/drafts/${second}/discard`, {})).status).toBe(200);
    const state = await untilDone(call);
    expect(sender.sent.map((s) => s.id)).toEqual([first, third]);
    expect(state.bulk).toMatchObject({ sent: 2, failed: [] });
    expect(ctxState.getDraft(second!)!.status).toBe("discarded");
  });

  it("doesn't send one that's being rewritten as a full reply", async () => {
    const sender = new FakeSender();
    const { call, ctxState, drafter } = await setupWith(sender);
    const [first, second] = ctxState.pendingDrafts("confirmation").map((d) => d.id);
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    const draft = drafter.draft.bind(drafter);
    drafter.draft = async (req) => {
      await slow;
      return draft(req);
    };
    const full = call(`/api/drafts/${first}/full`, {});
    await new Promise((r) => setTimeout(r, 20));
    expect((await call(`/api/drafts/${first}/approve`, { text: "hi" })).status).toBe(409);
    await call("/api/confirmations/send", { ids: [first, second] });
    const state = await untilDone(call);
    expect(sender.sent.map((s) => s.id)).toEqual([second]);
    expect(state.bulk.failed).toEqual([expect.objectContaining({ id: first, error: "This draft is being rewritten right now." })]);
    finish();
    expect(await (await full).json()).toMatchObject({ kind: "reply", status: "pending" });
  });

  it("leaves a confirmation queued if sending switches off mid-send", async () => {
    const sender = new FakeSender();
    // The kill switch flips between the run's check and the send itself.
    sender.send = async () => ({ sent: false, message: "approved; copy it into Jelly" });
    const { call, ctxState } = await setupWith(sender);
    await call("/api/confirmations/send", { ids: ctxState.pendingDrafts("confirmation").map((d) => d.id) });
    const state = await untilDone(call);
    expect(state.bulk).toMatchObject({ sent: 0, processed: 1 });
    expect(state.bulk.stoppedReason).toMatch(/switched off/);
    expect(ctxState.pendingDrafts("confirmation")).toHaveLength(3);
  });

  it("keeps a draft's first decision", async () => {
    const { ctxState } = await setupWith(new FakeSender());
    const id = ctxState.pendingDrafts("confirmation")[0]!.id;
    ctxState.setStatus(id, "sent", "sent through Jelly", "Thanks!");
    ctxState.setStatus(id, "stale", "someone already replied in Jelly");
    expect(ctxState.getDraft(id)).toMatchObject({ status: "sent", finalText: "Thanks!" });
  });

  async function setupWith(sender: Sender, gapMs = 0) {
    const ctx = await setup(foods(), sender, gapMs);
    return { ...ctx, ctxState: ctx.state };
  }
});
