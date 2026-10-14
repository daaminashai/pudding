import fs from "node:fs";
import path from "node:path";
import { JellySendError, JellySessionError, sendFields, type JellyClient } from "./jelly.js";
import { log } from "./log.js";
import { errorMessage } from "./redact.js";
import type { Draft } from "./state.js";

export interface SendResult {
  sent: boolean;
  message: string;
}

/** Approving either sends through Jelly or, when that's unavailable, records the reply for pasting by hand. */
export interface Sender {
  /** Null when approving sends; otherwise why it won't. */
  unavailableReason(): string | null;
  send(draft: Draft, text: string): Promise<SendResult>;
}

/** The conversation moved on in Jelly since the draft was written. Nothing was sent. */
export class ConversationChangedError extends JellySendError {
  constructor(message: string) {
    super(message, false);
    this.name = "ConversationChangedError";
  }
}

/** Someone has an unsent draft open in the conversation. Nothing was sent; try again later. */
export class DraftOpenError extends JellySendError {
  constructor(message: string) {
    super(message, false);
    this.name = "DraftOpenError";
  }
}

/** KILL_SWITCH=1 or a STOP file in the working dir blocks all sending, checked live. */
export function sendingBlockedBy(killSwitch: boolean, workDir: string): "KILL_SWITCH" | "STOP file" | null {
  if (killSwitch) return "KILL_SWITCH";
  if (fs.existsSync(path.join(workDir, "STOP"))) return "STOP file";
  return null;
}

export class ManualSender implements Sender {
  constructor(
    private readonly killSwitch: boolean,
    private readonly workDir: string,
  ) {}

  unavailableReason(): string {
    const blocked = sendingBlockedBy(this.killSwitch, this.workDir);
    if (blocked) return `Sending is switched off by ${blocked}. Approving copies the reply to paste into Jelly.`;
    return "Sending through Jelly is off (MODE isn't send). Approving copies the reply to paste into Jelly.";
  }

  async send(): Promise<SendResult> {
    return { sent: false, message: "approved; copy it into Jelly" };
  }
}

export interface JellySenderOptions {
  killSwitch: boolean;
  workDir: string;
  slackWebhookUrl?: string;
  fetch?: typeof fetch;
}

export class JellySender implements Sender {
  private sessionProblem: string | null = null;

  constructor(
    private readonly client: JellyClient,
    private readonly o: JellySenderOptions,
  ) {}

  unavailableReason(): string | null {
    const blocked = sendingBlockedBy(this.o.killSwitch, this.o.workDir);
    if (blocked) return `Sending is switched off by ${blocked}. Approving copies the reply to paste into Jelly.`;
    if (this.sessionProblem) {
      return `Sending stopped because the Jelly login stopped working (${this.sessionProblem}). See the README to reconnect.`;
    }
    return null;
  }

  /**
   * Before sending, reloads the conversation in Jelly (fresh CSRF token) and
   * refuses unless the latest message is still the one this draft answers and
   * nobody has a draft open. Never retries.
   */
  async send(draft: Draft, text: string): Promise<SendResult> {
    if (this.unavailableReason()) return { sent: false, message: "approved; copy it into Jelly" };
    const referer = this.client.conversationUrl(draft.conversationId);
    try {
      const page = await this.client.conversationPage(draft.conversationId);
      if (!page.latestPublicId) {
        throw new JellySendError("Not sent: couldn't tell which message is the latest one in Jelly", false);
      }
      if (page.latestPublicId !== draft.messageId) {
        throw new ConversationChangedError("Not sent: the conversation changed in Jelly (a new message or a reply)");
      }
      if (page.drafts > 0) {
        throw new DraftOpenError("Not sent: someone has an unsent draft open in this conversation in Jelly");
      }

      let form;
      try {
        form = await this.client.openReplyDraft(page, referer);
      } catch (err) {
        if (err instanceof JellySendError) {
          throw new JellySendError(`Not sent: ${err.message}. An empty reply draft may be left in Jelly.`, false);
        }
        throw err;
      }
      // Last chance to stop before the step that can't be undone.
      const blocked = sendingBlockedBy(this.o.killSwitch, this.o.workDir);
      if (blocked) {
        throw new JellySendError(`Not sent: ${blocked} switched sending off. An empty reply draft is left in Jelly.`, false);
      }
      await this.client.submitReply(page, form, sendFields(form, text), referer);
      return { sent: true, message: "sent through Jelly" };
    } catch (err) {
      if (err instanceof JellySessionError) await this.sessionDied(err.message);
      throw err;
    }
  }

  /** Flip to copy-and-paste mode for good: STOP file, stderr, Slack. */
  private async sessionDied(reason: string): Promise<void> {
    this.sessionProblem = reason;
    try {
      fs.writeFileSync(
        path.join(this.o.workDir, "STOP"),
        `Sending stopped ${new Date().toISOString()}: the Jelly login stopped working (${reason}).\n` +
          "Update JELLY_SESSION_COOKIE, delete this file, and restart.\n",
      );
    } catch (err) {
      log.error("couldn't write the STOP file", { error: errorMessage(err) });
    }
    log.error("Jelly session problem: sending is off", { reason });
    if (!this.o.slackWebhookUrl) return;
    try {
      await (this.o.fetch ?? fetch)(this.o.slackWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `Pudding stopped sending replies: the Jelly login stopped working (${reason}). Drafts still work; approving copies them until the cookie is updated.`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      log.error("couldn't post the Slack alert", { error: errorMessage(err) });
    }
  }
}
