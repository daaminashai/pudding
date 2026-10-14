# pudding

jelly sucks, pudding is better

Pudding drafts replies to every unanswered email in a Jelly shared inbox and puts them in a local dashboard. You read
each draft, edit it if you want, and approve or discard it. Nothing is sent without your click.

Fill in `.env`:

| Variable | What it is |
|---|---|
| `MARMALADE_BASE_URL` | Marmalade's URL, without `/api/rpc` |
| `MARMALADE_API_KEY` | Your Marmalade API key |
| `MAILBOX_ID` | The shared inbox's id (see below) |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Key for the model that writes drafts. With only an OpenAI key, drafts use `OPENAI_MODEL` (default `gpt-5.5`). With both, Anthropic is used unless `LLM_PROVIDER=openai`. |

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
