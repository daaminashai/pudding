import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LlmError } from "../src/llm.js";
import { finishReply, scan } from "../src/scan.js";
import { State } from "../src/state.js";
import { conversation, fixtures, withMessage } from "./fixtures.js";
import { knowledgeDir, MAILBOX, scanDeps } from "./helpers.js";

describe("scan", () => {
  it("drafts every unanswered email and skips automated mail", async () => {
    const clean = fixtures.clean();
    const attachment = conversation({ id: "cnv_attach", messages: [{ from: "sam@example.org", attachments: 2 }] });
    const noreply = fixtures.noreplySender();
    const newsletter = fixtures.listUnsubscribe();
    const answered = fixtures.latestOutbound();
    const { deps, state, drafter, marmalade } = scanDeps([clean, attachment, noreply, newsletter, answered]);

    const { progress } = await scan(deps);

    expect(progress).toMatchObject({ drafted: 2, skipped: 2, errors: [] });
    const drafts = state.pendingDrafts();
    expect(drafts.map((d) => d.conversationId).sort()).toEqual(["cnv_attach", "cnv_clean"]);
    expect(state.recentSkipped().map((s) => s.reason).sort()).toEqual([
      "headers: List-Unsubscribe present",
      "sender: automated sender: no-reply@service.example",
    ]);

    const draft = drafts.find((d) => d.conversationId === "cnv_clean")!;
    expect(draft.draft).toBe("hey! applications open march 3.");
    expect(draft.sender).toBe("jane@example.com");
    expect(draft.flags).toEqual([]);
    expect(drafts.find((d) => d.conversationId === "cnv_attach")!.flags.map((f) => f.kind)).toEqual(["attachments"]);

    // The drafter saw the knowledge docs and the thread.
    expect(drafter.calls[0]!.knowledge.docs[0]!.name).toBe("faq.md");
    expect(drafter.calls[0]!.thread.entries.at(-1)!.kind).toBe("inbound");

    // Read-only: every request to Marmalade was an authenticated GET.
    expect(marmalade.requests.length).toBeGreaterThan(0);
    expect(marmalade.requests.every((r) => r.method === "GET" && r.auth === "Bearer mk_test_key")).toBe(true);
    expect(marmalade.requests.some((r) => r.url.pathname.includes("/convo/"))).toBe(false);
  });

  it("doesn't draft the same email twice", async () => {
    const { deps, drafter } = scanDeps([fixtures.clean()]);
    await scan(deps);
    await scan(deps);
    expect(drafter.calls).toHaveLength(1);
  });

  it("drops a closing line the model adds, since Jelly adds the signature", async () => {
    const { deps, state, drafter } = scanDeps([fixtures.clean()]);
    drafter.respond = () => ({
      replyNeeded: true,
      reply: "march 3!\n\nCheers,\nDaamin\n\n",
      confidence: 0.9,
      needsHuman: false,
      note: "",
    });
    await scan(deps);
    expect(state.pendingDrafts()[0]!.draft).toBe("march 3!");
    expect(finishReply("see you there.\n\nKind regards")).toBe("see you there.");
    expect(finishReply("Best of luck with the jam")).toBe("Best of luck with the jam");
    expect(finishReply("ok!\nCheers")).toBe("ok!");
  });

  it("only fetches conversations with new activity on later scans", async () => {
    const a = conversation({ id: "cnv_a", messages: [{ from: "a@example.com" }] });
    const b = conversation({ id: "cnv_b", messages: [{ from: "b@example.com" }] });
    const { deps, drafter, marmalade } = scanDeps([a, b]);
    await scan(deps);
    expect(drafter.calls).toHaveLength(2);

    marmalade.requests.length = 0;
    const { progress, knowledge } = await scan(deps);
    expect(progress).toMatchObject({ phase: "done", conversations: 0, unchanged: 2, message: "No new emails since the last check." });
    // One listing call, nothing fetched, nothing learned, no model calls.
    expect(marmalade.requests.map((r) => r.url.pathname)).toEqual([`/api/rpc/mailboxes/${MAILBOX}/conversations`]);
    expect(knowledge).toBeNull();
    expect(drafter.calls).toHaveLength(2);

    marmalade.conversations[1] = withMessage(b, { from: "b@example.com", text: "one more thing", minutesAgo: 1 });
    marmalade.requests.length = 0;
    const next = await scan(deps);
    expect(next.progress).toMatchObject({ conversations: 1, unchanged: 1, drafted: 1 });
    const fetched = marmalade.requests.map((r) => r.url.pathname).filter((p) => /conversations\/[^/]+$/.test(p));
    expect(fetched).not.toContain(`/api/rpc/mailboxes/${MAILBOX}/conversations/cnv_a`);
    expect(drafter.calls).toHaveLength(3);
  });

  it("doesn't load the docs or past replies when nothing new needs a draft", async () => {
    const { deps, drafter, marmalade } = scanDeps([fixtures.noreplySender(), fixtures.latestOutbound()]);
    const { knowledge, progress } = await scan(deps);
    expect(progress).toMatchObject({ skipped: 1, drafted: 0 });
    expect(knowledge).toBeNull();
    expect(drafter.calls).toHaveLength(0);
    // Learning lists conversations by startDate; without it there's no such call.
    expect(marmalade.requests.some((r) => r.url.searchParams.has("startDate"))).toBe(false);
  });

  it("gives replies that only confirm a sign-up the fixed reply, without loading the docs", async () => {
    const food = conversation({ id: "cnv_food", subject: "Re: Bela: Haven + Framework 12", messages: [{ text: "Pizza 🍕" }] });
    const { deps, state, drafter } = scanDeps([food]);
    const { knowledge, progress } = await scan(deps);

    expect(progress.drafted).toBe(1);
    expect(knowledge).toBeNull();
    expect(drafter.calls).toHaveLength(0);
    expect(drafter.confirmationChecks).toEqual([{ subject: "Re: Bela: Haven + Framework 12", question: "Pizza 🍕" }]);
    expect(state.pendingDrafts("reply")).toEqual([]);
    expect(state.pendingDrafts("confirmation")).toEqual([
      expect.objectContaining({
        kind: "confirmation",
        draft: "Thanks! Your registration has been confirmed.",
        confidence: 1,
        needsHuman: false,
        note: "Just their favorite food.",
      }),
    ]);
  });

  it("writes a full draft when a confirmation reply also asks something", async () => {
    const food = conversation({ subject: "Re: Uday: Haven Sign Up Confirmation", messages: [{ text: "pizza! where is it?" }] });
    const { deps, state, drafter } = scanDeps([food]);
    await scan(deps);
    expect(drafter.confirmationChecks).toHaveLength(1);
    expect(drafter.calls).toHaveLength(1);
    expect(state.pendingDrafts("confirmation")).toEqual([]);
    expect(state.pendingDrafts("reply")).toHaveLength(1);
  });

  it("shows the check every message they sent, so an earlier question isn't missed", async () => {
    const twice = conversation({
      subject: "Re: Sam: Haven + Framework 12",
      messages: [
        { text: "can I bring my sister?", minutesAgo: 20 },
        { text: "Pizza!", minutesAgo: 10 },
      ],
    });
    const { deps, state, drafter } = scanDeps([twice]);
    await scan(deps);
    expect(drafter.confirmationChecks[0]!.question).toBe("can I bring my sister?\n\n--- their next message ---\n\nPizza!");
    expect(state.pendingDrafts("confirmation")).toEqual([]);
    expect(state.pendingDrafts("reply")).toHaveLength(1);
  });

  it("looks again when lastMessageAt is ahead of the messages Marmalade returned", async () => {
    const c = fixtures.clean();
    // A message that hasn't synced yet: the conversation says it's newer than anything in it.
    const ahead = { ...c, lastMessageAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    const { deps, marmalade } = scanDeps([ahead]);
    await scan(deps);
    marmalade.requests.length = 0;
    const { progress } = await scan(deps);
    expect(progress.conversations).toBe(1);
    expect(marmalade.requests.some((r) => r.url.pathname.endsWith(`/conversations/${c.id}`))).toBe(true);
  });

  it("only checks unanswered replies to the confirmation email", async () => {
    const answered = conversation({
      subject: "Re: Zack: Haven + Framework 12",
      messages: [
        { text: "tacos", minutesAgo: 30 },
        { inbound: false, from: "team@ours.example", text: "confirmed!", minutesAgo: 20 },
        { text: "so my friend can use my link?", minutesAgo: 10 },
      ],
    });
    const { deps, drafter } = scanDeps([answered, fixtures.clean()]);
    await scan(deps);
    expect(drafter.confirmationChecks).toEqual([]);
    expect(drafter.calls).toHaveLength(2);
  });

  it("moves confirmations already waiting in the queue, checking each draft once", async () => {
    const file = path.join(knowledgeDir(), "state.db");
    const food = conversation({ id: "cnv_food", subject: "Re: Bela: Haven + Framework 12", messages: [{ text: "Momos" }] });
    const question = conversation({ id: "cnv_q", subject: "Re: Uday: Haven + Framework 12", messages: [{ text: "where?" }] });
    const { deps, drafter } = scanDeps([food, question, fixtures.clean()]);
    // Drafted before confirmations existed: everything is a normal reply, never checked.
    drafter.respondToConfirmation = () => ({ onlyConfirmation: false, reason: "" });
    const state = new State(file);
    await scan({ ...deps, state });
    expect(state.pendingDrafts("reply")).toHaveLength(3);
    state.close();
    const raw = new Database(file);
    raw.prepare("UPDATE drafts SET confirmation_checked = 0").run();
    raw.close();

    drafter.respondToConfirmation = (q) => ({ onlyConfirmation: q === "Momos", reason: "Just a food." });
    drafter.confirmationChecks.length = 0;
    const reopened = new State(file);
    await scan({ ...deps, state: reopened });
    expect(reopened.pendingDrafts("confirmation")).toEqual([
      expect.objectContaining({ conversationId: "cnv_food", draft: "Thanks! Your registration has been confirmed." }),
    ]);
    expect(reopened.pendingDrafts("reply").map((d) => d.conversationId).sort()).toEqual(["cnv_clean", "cnv_q"]);
    // Only the two that look like confirmation replies needed the model.
    expect(drafter.confirmationChecks.map((c) => c.question).sort()).toEqual(["Momos", "where?"]);

    drafter.confirmationChecks.length = 0;
    await scan({ ...deps, state: reopened });
    expect(drafter.confirmationChecks).toEqual([]);
    reopened.close();
  });

  it("replaces a pending draft when a newer message arrives", async () => {
    const c = fixtures.clean();
    const { deps, state, marmalade } = scanDeps([c]);
    await scan(deps);
    const first = state.pendingDrafts()[0]!;

    marmalade.conversations[0] = withMessage(c, { text: "also, is it free?", minutesAgo: 1 });
    await scan(deps);

    const pending = state.pendingDrafts();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(first.id);
    expect(state.getDraft(first.id)).toMatchObject({ status: "stale", statusReason: "a newer message arrived" });
  });

  it("marks a pending draft stale once someone replies in Jelly", async () => {
    const c = fixtures.clean();
    const { deps, state, marmalade } = scanDeps([c]);
    await scan(deps);
    marmalade.conversations[0] = withMessage(c, { inbound: false, from: "team@ours.example", minutesAgo: 1 });
    await scan(deps);
    expect(state.pendingDrafts()).toEqual([]);
    expect(state.decidedDrafts()[0]).toMatchObject({ status: "stale", statusReason: "answered in Jelly" });
  });

  it("takes drafts out of the queue once their conversation is archived in Jelly", async () => {
    const [a, b, c] = ["a", "b", "c"].map((x) => conversation({ id: `cnv_${x}`, messages: [{ from: `${x}@example.com` }] }));
    const { deps, state, marmalade } = scanDeps([a!, b!, c!]);
    await scan(deps);
    // Archived conversations drop out of the open list, with or without a reply.
    marmalade.conversations[0] = { ...a!, status: "archived" };
    marmalade.conversations[1] = {
      ...withMessage(b!, { inbound: false, from: "team@ours.example", minutesAgo: 1 }),
      status: "archived",
    };
    marmalade.requests.length = 0;

    const { progress } = await scan(deps);

    expect(state.pendingDrafts().map((d) => d.conversationId)).toEqual(["cnv_c"]);
    expect(Object.fromEntries(state.decidedDrafts().map((d) => [d.conversationId, d.statusReason]))).toEqual({
      cnv_a: "archived in Jelly",
      cnv_b: "answered and archived in Jelly",
    });
    expect(progress.message).toBe("No new emails since the last check. Took out 2 draft(s) already handled in Jelly.");
    // Only those two were looked up again.
    const fetched = marmalade.requests.map((r) => r.url.pathname).filter((p) => /conversations\/[^/]+$/.test(p));
    expect(fetched.sort()).toEqual(["cnv_a", "cnv_b"].map((id) => `/api/rpc/mailboxes/${MAILBOX}/conversations/${id}`));
  });

  it("flags assigned conversations instead of skipping them", async () => {
    const { deps, state, marmalade } = scanDeps([fixtures.clean()]);
    marmalade.assignments.cnv_clean = [
      { id: 1, conversationId: "cnv_clean", jellyContactId: "12642", createdAt: new Date().toISOString() },
    ];
    await scan(deps);
    expect(state.pendingDrafts()[0]!.flags).toEqual([{ kind: "assigned", detail: "assigned to Alex Rivera" }]);
  });

  it("flags made-up facts and AI-sounding writing", async () => {
    const { deps, state, drafter } = scanDeps([fixtures.clean()]);
    drafter.respond = () => ({
      replyNeeded: true,
      reply: "Great question! Applications open March 3 — the fee is $40, see https://example.org/apply.",
      confidence: 0.8,
      needsHuman: false,
      note: "",
    });
    await scan(deps);
    const flags = state.pendingDrafts()[0]!.flags;
    expect(flags.find((f) => f.kind === "unverified")!.detail).toMatch(/number 40.*link https:\/\/example\.org\/apply|link.*number 40/);
    expect(flags.find((f) => f.kind === "ai_style")!.detail).toContain("em dash");
  });

  it("queues an empty draft when the model can't write one, but retries transient failures", async () => {
    const declined = conversation({ id: "cnv_declined", messages: [{ from: "a@example.com" }] });
    const flaky = conversation({ id: "cnv_flaky", messages: [{ from: "b@example.com" }] });
    const { deps, state, drafter } = scanDeps([declined, flaky]);
    drafter.respond = (req) =>
      req.thread.entries[0]!.from === "a@example.com"
        ? new LlmError("the model declined to draft this (cyber)", false)
        : new LlmError("Anthropic rate limit", true);

    const { progress } = await scan(deps);
    expect(progress.errors).toHaveLength(1);
    expect(state.pendingDrafts()).toEqual([
      expect.objectContaining({ conversationId: "cnv_declined", draft: "", needsHuman: true }),
    ]);
    expect(state.pendingDrafts()[0]!.note).toContain("declined");

    drafter.respond = () => ({ replyNeeded: true, reply: "ok!", confidence: 0.9, needsHuman: false, note: "" });
    await scan(deps);
    expect(state.pendingDrafts().map((d) => d.conversationId).sort()).toEqual(["cnv_declined", "cnv_flaky"]);
  });

  it("keeps going when one conversation can't be fetched", async () => {
    const { deps, state, marmalade } = scanDeps([fixtures.clean(), conversation({ id: "cnv_down" })]);
    marmalade.failing.add("cnv_down");
    const { progress } = await scan(deps);
    expect(progress.errors[0]).toMatch(/cnv_down.*503/);
    expect(state.pendingDrafts().map((d) => d.conversationId)).toEqual(["cnv_clean"]);

    // It wasn't marked as checked, so the next scan tries it again.
    marmalade.failing.delete("cnv_down");
    const next = await scan(deps);
    expect(next.progress).toMatchObject({ conversations: 1, drafted: 1, errors: [] });
  });

  it("learns from past replies and from approved drafts", async () => {
    const past = conversation({
      id: "cnv_past",
      subject: "Is it free?",
      messages: [
        { from: "old@example.com", text: "is it free?", minutesAgo: 600 },
        { inbound: false, from: "team@ours.example", text: "yep, totally free!", minutesAgo: 590 },
      ],
    });
    const { deps, state, drafter, marmalade } = scanDeps([past, fixtures.clean()]);
    await scan(deps);
    expect(drafter.calls[0]!.knowledge.examples).toEqual([
      expect.objectContaining({ question: "is it free?", reply: "yep, totally free!", source: "past" }),
    ]);

    const draft = state.pendingDrafts()[0]!;
    state.setStatus(draft.id, "approved", "test", "hey jane, march 3!");
    marmalade.conversations.push(conversation({ id: "cnv_next", messages: [{ from: "kim@example.com" }] }));
    await scan(deps);
    expect(drafter.calls[1]!.knowledge.examples.at(-1)).toMatchObject({ reply: "hey jane, march 3!", source: "approved" });
  });

  it("handles Marmalade listing the same conversation more than once", async () => {
    const c = fixtures.clean();
    const { deps, drafter, state } = scanDeps([c, c, c]);
    const { progress } = await scan(deps);
    expect(progress.conversations).toBe(1);
    expect(drafter.calls).toHaveLength(1);
    expect(state.pendingDrafts()).toHaveLength(1);
  });

  it("skips emails the drafter says need no reply, with its reason", async () => {
    const { deps, state, drafter } = scanDeps([fixtures.clean()]);
    drafter.respond = () => ({ replyNeeded: false, reply: "", confidence: 0.9, needsHuman: false, note: "Just a thank-you." });
    await scan(deps);
    expect(state.pendingDrafts()).toEqual([]);
    expect(state.recentSkipped()[0]!.reason).toBe("no reply needed: Just a thank-you.");
  });

  it("learns each stock reply at most twice and leaves out our signature", async () => {
    const stock = (id: string) =>
      conversation({
        id,
        messages: [
          { from: `${id}@example.com`, text: "My favorite food is tacos!", minutesAgo: 600 },
          {
            inbound: false,
            from: "team@ours.example",
            text: "thats awesome!\nYour registration has been confirmed.\nSana Deghat (She/Her)\n\nsana@hackclub.com",
            minutesAgo: 590,
          },
        ],
      });
    const { deps, drafter, marmalade } = scanDeps([stock("a"), stock("b"), stock("c"), stock("d")]);
    marmalade.conversations.push(fixtures.clean());
    await scan(deps);
    const examples = drafter.calls[0]!.knowledge.examples;
    expect(examples).toHaveLength(2);
    expect(examples[0]!.reply).toBe("thats awesome!\nYour registration has been confirmed.");
  });

  it("stops the whole run when the model account can't be used (no credits, bad key)", async () => {
    const convos = ["a", "b", "c", "d", "e", "f"].map((x) => conversation({ id: `cnv_${x}`, messages: [{ from: `${x}@example.com` }] }));
    const { deps, state, drafter } = scanDeps(convos);
    drafter.respond = () => new LlmError("the OpenAI account has no credits left", false, true);
    await expect(scan(deps)).rejects.toThrow(/Stopped after 0 new draft\(s\): the OpenAI account has no credits left/);
    expect(drafter.calls.length).toBeLessThanOrEqual(3); // only the calls already in flight
    expect(state.pendingDrafts()).toEqual([]);
    expect(state.recentSkipped()).toEqual([]);
  });
});
