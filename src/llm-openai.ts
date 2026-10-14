import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { LlmError, OutputSchema, PromptDrafter, type PromptParts, type RawDraft } from "./llm.js";

/** Same prompt and rewrite pass as the Anthropic drafter, via the OpenAI Responses API. */
export class OpenAIDrafter extends PromptDrafter {
  private readonly client: OpenAI;

  constructor(
    private readonly model: string,
    client?: OpenAI,
  ) {
    super();
    // Drafts run in parallel and prompts are large, so ride out rate limits rather than fail.
    this.client = client ?? new OpenAI({ maxRetries: 6 });
  }

  protected async complete(parts: PromptParts): Promise<RawDraft> {
    let response;
    try {
      response = await this.client.responses.parse({
        model: this.model,
        // Instructions and knowledge are identical across a run; OpenAI caches the shared prefix automatically.
        instructions: `${parts.instructions}\n\n${parts.knowledge}`,
        input: parts.user,
        text: { format: zodTextFormat(OutputSchema, "email_draft") },
        prompt_cache_key: "pudding-drafts",
        max_output_tokens: 16_000,
        store: false,
      });
    } catch (err) {
      throw toLlmError(err);
    }
    const refusal = response.output
      .flatMap((item) => (item.type === "message" ? item.content : []))
      .find((c) => c.type === "refusal");
    if (refusal) throw new LlmError(`the model declined to draft this: ${refusal.refusal}`, false);
    if (response.status === "incomplete") {
      throw new LlmError(`model output was cut off (${response.incomplete_details?.reason ?? "unknown"})`, false);
    }
    if (!response.output_parsed) throw new LlmError("model output did not match the schema", false);
    return response.output_parsed;
  }
}

function toLlmError(err: unknown): LlmError {
  // Out of credits is a 429 too, but waiting won't fix it. OpenAI doesn't always set the code.
  if (err instanceof OpenAI.RateLimitError && (err.code === "insufficient_quota" || /credits|quota|billing/i.test(err.message))) {
    return new LlmError("the OpenAI account has no credits left; add some at platform.openai.com", false, true);
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new LlmError(`OpenAI rejected the API key (${err.status})`, false, true);
  }
  if (err instanceof OpenAI.RateLimitError) return new LlmError(`OpenAI rate limit: ${err.message}`, true);
  if (err instanceof OpenAI.InternalServerError) return new LlmError(`OpenAI ${err.status}`, true);
  if (err instanceof OpenAI.APIConnectionError) return new LlmError("could not reach OpenAI", true);
  if (err instanceof OpenAI.APIError) return new LlmError(`OpenAI ${err.status}: ${err.message}`, false);
  return new LlmError(err instanceof Error ? err.message : String(err), false);
}
