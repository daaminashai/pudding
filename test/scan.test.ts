import { describe, expect, it } from "vitest";
import { LlmError } from "../src/llm.js";
import { scan } from "../src/scan.js";
import { conversation, fixtures, withMessage } from "./fixtures.js";
import { MAILBOX, scanDeps } from "./helpers.js";

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
    expect(draft.draft).toBe("hey! applications open march 3.\n\ncheers,\nthe team");
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
