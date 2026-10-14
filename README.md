<h2 align="center" style="font-size: 52px; font-family: 'system-ui';">pudding</h2>
<p align="center">jelly sucks, pudding is better</p>
<p align="center">
 <img src="https://img.shields.io/badge/License-MIT-blue.svg">
 <img src="https://img.shields.io/badge/version-0.1.0-green.svg">
 <img src="https://img.shields.io/github/stars/daaminashai/pudding?style=social" alt="GitHub Stars">
</p>

pudding is an automated-replier for a shared inbox in [Jelly](https://letsjelly.com). It reads every email that hasn't been
answered yet, writes a reply that sounds like your previous, and lines them all up in a clean dashboard. Each draft can be edited and needs to be approved to be sent out.

it was built for the [Hack Club Haven](https://haven.hackclub.com) inbox, where a lot of the mail is the same handful of
questions, but it works for any Jelly inbox.

## features

- **draft every reply**: every unanswered email gets a ready-to-send draft, written from your docs and the replies
  your team has sent before.
- **one-click sending**: approving sends the reply straight from Jelly, with your signature, exactly as if you had typed
  it yourself.
- **bulk confirmations**: sign-up confirmation replies ("my favorite food is pizza!") get collected in one tab and
  confirmed all at once.
- **bulk actions**: tick drafts in To review to send or discard them together.
- **careful by default**: it won't send if someone already replied, a teammate has a draft open, or the conversation
  changed. there's also a kill switch.

## how it works

1. Pudding checks the inbox for emails nobody has answered yet.
2. It skips anything that doesn't need a reply, like auto-replies, bounces and newsletters.
3. It writes a draft for the rest, using your docs in `knowledge/` and your team's past replies.
4. You review the drafts at `localhost:4545` and approve, rewrite or discard each one.

## running it

```bash
npm install
cp .env.example .env   # add your Marmalade and OpenAI (or Anthropic) keys
npm start
```

Every setting is explained in [`.env.example`](.env.example).

