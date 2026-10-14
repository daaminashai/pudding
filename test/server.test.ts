import fs from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scan } from "../src/scan.js";
import { ManualSender } from "../src/send.js";
import { Dashboard } from "../src/server.js";
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

async function setup(conversations = [fixtures.clean()]) {
  const ctx = scanDeps(conversations);
  await scan(ctx.deps);
  const dashboard = new Dashboard({ ...ctx.deps, sender: new ManualSender(false, knowledgeDir()) }, webDir());
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
