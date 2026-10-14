# pudding

jelly sucks, pudding is better

Pudding drafts replies to every unanswered email in a Jelly shared inbox and puts them in a local dashboard. You read
each draft, edit it if you want, and approve or discard it. Nothing is sent without your click.

```
npm start
  → finds open conversations with new activity since the last check
  → skips automated mail and anything that needs no answer
  → learns from your docs and past replies, and drafts the rest
  → http://localhost:4545: review, edit, approve / rewrite / discard
```

By default **Approve** saves your final text and copies it to the clipboard for you to paste into the conversation in
Jelly. To have it send through Jelly for you, see [Sending through Jelly](#sending-through-jelly).

Marmalade doesn't include a link to each conversation, so for an **Open in Jelly** button set `JELLY_CONVERSATION_URL`
in `.env` to a conversation's address in Jelly with the id replaced by `{id}`.

## Setup

Needs Node 20+.

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | What it is |
|---|---|
| `MARMALADE_BASE_URL` | Marmalade's URL, without `/api/rpc` |
| `MARMALADE_API_KEY` | Your Marmalade API key |
| `MAILBOX_ID` | The shared inbox's id (see below) |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Key for the model that writes drafts. With only an OpenAI key, drafts use `OPENAI_MODEL` (default `gpt-5.5`). With both, Anthropic is used unless `LLM_PROVIDER=openai`. |

Then look at your inbox through Marmalade once:

```bash
npm run inspect
```

With `MAILBOX_ID` empty, this lists the mailboxes your key can see. Mailbox-scoped keys can't list mailboxes, so if
it says so, copy the id from Marmalade (where the key was made) or from the inbox's URL in Jelly. Once it's set, the
run prints the conversation statuses in use, checks which field `startDate` filters on, and saves one full
conversation to `data/inspect/<id>.json` with a summary of what's in each message's `metadata`. It only reads.

### Knowledge

Put the documents replies should be based on in `knowledge/` as `.md` or `.txt`: the FAQ, the organizer doc,
anything else that's true and current. To export a Google Doc, use File → Download → Markdown or Plain text. Images
embedded in the export are stripped automatically. Every file is sent with every draft, so remove outdated ones.
Files starting with `_` aren't sent.

`knowledge/_style.md` holds an optional fixed sign-off and notes on tone. Leave it alone to start: the drafter already
copies the voice of your past replies, and leaves out the signature block (name, title, email, Hack Club footer)
because Jelly adds each sender's own when the reply goes out.

## Using it

```bash
npm start
```

This opens the dashboard at http://localhost:4545 and checks the inbox straight away. Click **Check inbox** to look
again later. Stop it with Ctrl-C.

Each draft card shows the latest message (expand for the whole thread, including internal notes), the drafted reply in
an editable box, and badges for what to look at:

| Badge | Meaning |
|---|---|
| `NN% confident` | How likely the drafter thinks you can send it unchanged |
| Needs a careful look | The drafter isn't sure: the docs don't cover it, or it's a complaint, refund, money, legal or other sensitive email. Its note says why. |
| Check the facts | The reply contains a link, email address, number, price or date that isn't in your docs, past replies or the thread |
| Sounds AI-written | Em dashes, markdown, bullet lists or stock phrases ("Great question", "Feel free to reach out"…) survived the rewrite pass |
| Assigned | Someone on the team is assigned to the conversation |
| Has attachments | The sender attached files the drafter couldn't see |
| Long thread | Many back-and-forths; worth reading the whole thread |

- **Approve & copy** checks the conversation hasn't changed since the draft was written, saves your final text and
  copies it. If a newer message arrived or someone already replied, it refuses and marks the draft out of date.
- **Redo…** redrafts, optionally with instructions ("shorter", "mention the deadline", "say no politely").
- **Discard** drops the draft. That email won't be drafted again unless the sender writes back.

Drafts persist in `data/state.db`, so you can stop and come back. Pudding also remembers when it last checked each
conversation, so a later check (including the one at startup) only fetches conversations with a new message since
then, and only calls the model for emails that don't have a draft yet. If nothing needs drafting, it doesn't load the
docs or past replies either. A check replaces drafts whose conversation got a new message and retires drafts for
conversations someone answered in Jelly. Anything that failed (Marmalade down, the model rate-limited) is tried again
on the next check.

`npm run scan` does the same check without the dashboard, for queueing drafts ahead of time.

### What gets skipped

These get no draft and are listed under the Skipped tab, each with a **Draft anyway** button in case it got one
wrong:

- auto-replies and bounces (by subject: "Automatic reply", "Out of Office", "Undeliverable"…) and Gmail emoji
  reactions
- emails the drafter judges need no answer from you, such as a "sounds good, thanks!" that closes the thread; its
  reason is shown. If past replies show the team answering messages like it (say, "my favorite food is tacos" to
  confirm a registration), it drafts a reply
- if Marmalade ever includes sender addresses or headers: no-reply, mailer-daemon, postmaster or notifications
  senders, and `Auto-Submitted`, `Precedence: bulk/list/junk` or `List-Unsubscribe` headers. Right now it includes
  neither, so these checks have nothing to go on

### How it learns

Every draft is written with three things in the prompt:

1. your `knowledge/` docs
2. up to `LEARN_MAX_EXAMPLES` question/reply pairs from conversations the team answered in the last `LEARN_FROM_DAYS`
   days, pulled from Marmalade with quoted history and signatures stripped, and cached in `data/state.db` so later
   runs only fetch what changed. Each distinct reply is kept at most twice, so a stock answer like "your
   registration has been confirmed" can't crowd out the rest. The first run reads up to 300 conversations, which
   takes a couple of minutes
3. the 40 most recent replies you approved, in their final edited form

So the edits you make before approving shape the next drafts. The docs and examples are identical for every email in a
run, so they're sent as a cached prompt prefix: after the first draft, each one costs a fraction of the full prompt.

### How replies stay human

The drafter is told to match your past replies' voice and length, write plain text with no markdown, lists or em
dashes, skip stock phrases, answer only what was asked, and never state a fact, link, price, date or promise that isn't
in the docs, past replies or thread. Each draft is then checked in code: if it has AI tells, it's sent back once for a
rewrite, and whatever's left shows up as a badge. Invented facts are flagged the same way.

## Safety

- **Read-only on Marmalade.** The client can only issue GET requests. Marmalade's `convo/*/create` endpoints write to
  its own database rather than Jelly, and `setStatus`/`assign` may or may not write through, so none of them are ever
  called.
- **Nothing is sent automatically.** Every reply needs your approval in the dashboard.
- **The dashboard is local.** It listens on 127.0.0.1 only. API calls need a token that's generated at each start and
  only embedded in the page, so other websites open in your browser can't approve drafts. Requests for any hostname
  other than localhost are rejected, which blocks DNS rebinding.
- **Secrets stay out of logs.** API keys, cookies, CSRF tokens and webhook URLs are redacted from every log line and
  error.
- **Kill switch.** `KILL_SWITCH=1` or a file named `STOP` in the working directory blocks sending, checked on every
  approval and again right before the send.
- `data/` (drafts, learned examples, inspected conversations) and your knowledge docs are gitignored, since they hold
  email content and possibly internal documents.

## Sending through Jelly

With `MODE=send` and a Jelly login in `.env`, **Approve & send** sends the reply from Jelly exactly as if you'd typed
it: Jelly fills in To, From, the subject, your signature and the quoted email, and the conversation is archived
afterwards, as when you click Send by hand. Before every send Pudding loads the conversation in Jelly and refuses if:

- a newer message has arrived, or someone has already replied
- someone has an unsent draft open in the conversation
- `KILL_SWITCH=1` or a `STOP` file appeared (checked again right before the final step)

It never retries a send. If Jelly doesn't answer clearly (a timeout, a server error), the draft is marked as sent with
a warning to check Jelly, so a second copy can't go out. If the login stops working (a redirect to sign-in, a 401 or
403, or a CSRF failure), it creates the `STOP` file, posts to `SLACK_WEBHOOK_URL` if set, and goes back to copying.

### Connecting your Jelly login

1. In Chrome, open any conversation in Jelly.
2. Press Cmd-Option-I, open the **Network** tab, type `method:POST` in the filter box.
3. Click **Reply** in Jelly (no need to send anything). A row appears in the Network tab.
4. Right-click it → **Copy** → **Copy as cURL**, then run:

   ```bash
   npm run capture -- --save-cookie
   ```

   This reads the clipboard, saves only the two login cookies to `.env` (never printed), and shows the rest of the
   request with every secret hidden.
5. Set `MODE=send` in `.env`, delete any `STOP` file, and restart with `npm start`.

Signing out of Jelly ends that login; repeat these steps after signing back in. Never paste the cURL anywhere else:
it contains your login.

## Development

```bash
npm test          # vitest; Marmalade and the model APIs are mocked
npm run typecheck
```

| Path | |
|---|---|
| `src/index.ts` | `npm start` / `npm run scan` |
| `src/scan.ts` | finds unanswered emails, skips or flags them, drafts the rest |
| `src/llm.ts` | the prompt, the AI-style rewrite pass, and the Anthropic call |
| `src/llm-openai.ts` | the same, via the OpenAI Responses API |
| `src/knowledge.ts` | docs, style, learning from past conversations |
| `src/guardrails.ts` | skip checks and flags |
| `src/grounding.ts`, `src/humanize.ts` | invented-fact and AI-style checks |
| `src/server.ts`, `src/dashboard.html` | the dashboard |
| `src/send.ts`, `src/jelly.ts` | sending: copy-and-paste mode, or through Jelly with your session |
| `src/capture.ts` | `npm run capture`: summarizes a DevTools request with secrets hidden; saves the login cookie |
| `src/marmalade.ts`, `src/metadata.ts` | read-only Marmalade client; sender and header parsing |
| `src/state.ts` | SQLite: drafts, skipped emails, learned examples |
