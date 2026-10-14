import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { Knowledge } from "../src/knowledge.js";
import { LlmError } from "../src/llm.js";
import { OpenAIDrafter } from "../src/llm-openai.js";

const knowledge: Knowledge = {
  docs: [{ name: "faq.md", text: "Applications open March 3." }],
  examples: [],
  style: { signOff: null, notes: "" },
};
const thread = {
  subject: "When?",
  entries: [{ kind: "inbound" as const, from: "jane@example.com", at: "2026-10-14T10:00:00Z", text: "when do apps open?" }],
};

function fakeClient(responses: Array<Record<string, unknown>>) {
  const calls: Array<Record<string, any>> = [];
  const client = {
    responses: {
      parse: async (params: Record<string, any>) => {
        calls.push(params);
        return responses.shift();
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

const ok = (reply: string) => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
  output_parsed: { reply_needed: true, reply, confidence: 0.9, needs_human: false, note: "" },
});

describe("OpenAIDrafter", () => {
  it("puts instructions and knowledge in the cached prefix and the email in the input", async () => {
    const { client, calls } = fakeClient([ok("march 3!")]);
    const result = await new OpenAIDrafter("gpt-5.5", client).draft({ thread, knowledge, senderName: null });
    expect(result).toEqual({ replyNeeded: true, reply: "march 3!", confidence: 0.9, needsHuman: false, note: "" });
    expect(calls[0]!.model).toBe("gpt-5.5");
    expect(calls[0]!.instructions).toContain("No em dashes");
    expect(calls[0]!.instructions).toContain("Applications open March 3.");
    expect(calls[0]!.input).toContain("when do apps open?");
    expect(calls[0]!.text.format.type).toBe("json_schema");
    expect(calls[0]!.store).toBe(false);
  });

  it("asks for one rewrite when the draft sounds AI-written", async () => {
    const { client, calls } = fakeClient([ok("Great question! March 3 — see you."), ok("march 3, see you")]);
    const result = await new OpenAIDrafter("gpt-5.5", client).draft({ thread, knowledge, senderName: null });
    expect(result.reply).toBe("march 3, see you");
    expect(calls[1]!.input).toContain("Rewrite it without these");
  });

  it("turns a refusal into a non-retryable error", async () => {
    const { client } = fakeClient([
      { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], output_parsed: null },
    ]);
    const err = await new OpenAIDrafter("gpt-5.5", client).draft({ thread, knowledge, senderName: null }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.transient).toBe(false);
  });

  it("treats a cut-off response as an error", async () => {
    const { client } = fakeClient([
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], output_parsed: null },
    ]);
    const err = await new OpenAIDrafter("gpt-5.5", client).draft({ thread, knowledge, senderName: null }).catch((e) => e);
    expect(err.message).toContain("max_output_tokens");
  });

  it("treats running out of credits as fatal, not a rate limit to wait out", async () => {
    const noCredits = new OpenAI.RateLimitError(
      429,
      { message: "You have no credits remaining. Add credits to continue using the API." },
      "You have no credits remaining. Add credits to continue using the API.",
      new Headers(),
    );
    const client = { responses: { parse: async () => { throw noCredits; } } } as unknown as OpenAI;
    const err = await new OpenAIDrafter("gpt-5.5", client).draft({ thread, knowledge, senderName: null }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.fatal).toBe(true);
    expect(err.transient).toBe(false);
  });
});
