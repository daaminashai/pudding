import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfirmationCheck } from "../src/confirmations.js";
import type { DraftRequest, DraftResult, Drafter } from "../src/llm.js";
import { MarmaladeClient, type Assignment, type ConversationDetail } from "../src/marmalade.js";
import type { ScanDeps } from "../src/scan.js";
import { State } from "../src/state.js";

export const MAILBOX = "mb_1";

/**
 * A Marmalade double behind a mocked fetch. Mutate `conversations` and
 * `assignments` between scans to simulate the inbox changing.
 */
export function fakeMarmalade(conversations: ConversationDetail[]) {
  const requests: Array<{ method: string; url: URL; auth: string | undefined }> = [];
  const assignments: Record<string, Assignment[]> = {};
  const failing = new Set<string>();

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ method: init?.method ?? "GET", url, auth: headers.Authorization });
    const p = url.pathname.replace(/^\/api\/rpc/, "");
    if (p === `/mailboxes/${MAILBOX}/conversations`) {
      return json(
        conversations.map((c) => {
          const { messages: _m, comments: _c, ...summary } = c;
          return { conversation: summary, mailboxId: MAILBOX };
        }),
      );
    }
    if (p === "/members") {
      return json([{ jelly: { id: "12642", name: "Alex Rivera", email: "alex@hackclub.com" }, marmalade: null }]);
    }
    let m = new RegExp(`^/mailboxes/${MAILBOX}/conversations/([^/]+)/assignment$`).exec(p);
    if (m) return json(assignments[m[1]!] ?? []);
    m = new RegExp(`^/mailboxes/${MAILBOX}/conversations/([^/]+)$`).exec(p);
    if (m) {
      if (failing.has(m[1]!)) return new Response("upstream down", { status: 503 });
      const c = conversations.find((x) => x.id === m![1]);
      return c ? json(c) : new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const client = new MarmaladeClient({
    baseUrl: "https://marmalade.test",
    apiKey: "mk_test_key",
    fetch: fetchImpl,
    retries: 0,
  });
  return { client, requests, conversations, assignments, failing };
}

export class FakeDrafter implements Drafter {
  calls: DraftRequest[] = [];
  confirmationChecks: Array<{ subject: string; question: string }> = [];
  /** By default anything that's just a food word or two confirms; tests override it. */
  respondToConfirmation: (question: string) => ConfirmationCheck | Error = (question) =>
    question.includes("?")
      ? { onlyConfirmation: false, reason: "Also asks a question." }
      : { onlyConfirmation: true, reason: "Just their favorite food." };
  constructor(
    public respond: (req: DraftRequest) => DraftResult | Error = () => ({
      replyNeeded: true,
      reply: "hey! applications open march 3.",
      confidence: 0.9,
      needsHuman: false,
      note: "",
    }),
  ) {}

  async checkConfirmation(subject: string, question: string): Promise<ConfirmationCheck> {
    this.confirmationChecks.push({ subject, question });
    const result = this.respondToConfirmation(question);
    if (result instanceof Error) throw result;
    return result;
  }

  async draft(req: DraftRequest): Promise<DraftResult> {
    this.calls.push(req);
    const result = this.respond(req);
    if (result instanceof Error) throw result;
    return result;
  }
}

export function knowledgeDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pudding-test-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

export function scanDeps(conversations: ConversationDetail[], files?: Record<string, string>) {
  const marmalade = fakeMarmalade(conversations);
  const drafter = new FakeDrafter();
  const state = new State(":memory:");
  const deps: ScanDeps = {
    config: {
      mailboxId: MAILBOX,
      unansweredLookbackDays: 30,
      learnFromDays: 180,
      learnMaxExamples: 100,
      longThreadMessages: 6,
      jellyConversationUrl: "https://jelly.test/conversations/{id}",
      knowledgeDir: knowledgeDir(
        files ?? {
          "faq.md": "Applications open March 3. It's free.",
          "_style.md": "---\nsign_off: |\n  cheers,\n  the team\n---\nshort and friendly",
        },
      ),
    },
    marmalade: marmalade.client,
    drafter,
    state,
  };
  return { deps, marmalade, drafter, state };
}
