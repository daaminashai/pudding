<h1 align="center" style="font-size: 52px; font-family: 'system-ui';">🍮 Pudding</h1>
<p align="center"><i>jelly sucks, pudding is better</i></p>
<p align="center">
 <img src="https://img.shields.io/badge/License-MIT-blue.svg">
 <img src="https://img.shields.io/badge/version-0.1.0-green.svg">
 <img src="https://img.shields.io/github/stars/daaminashai/pudding?style=social" alt="GitHub Stars">
</p>

Pudding is an assistant for a shared inbox in [Jelly](https://letsjelly.com). It reads every email that hasn't been
answered yet, writes a reply that sounds like your team wrote it, and lines them all up in a clean dashboard. You read
each one, tweak it if you want, and click send. Nothing ever goes out without your click.

It was built for the [Hack Club](https://hackclub.com) Haven inbox, where a lot of the mail is the same handful of
questions, but it works for any Jelly inbox.

## Features

- **Drafts every reply**: Every unanswered email gets a ready-to-send draft, written from your docs and the replies
  your team has sent before.
- **Sounds like a person**: No "I hope this email finds you well", no em dashes, no bullet-point essays. Short,
  friendly, and in your team's voice.
- **One-click sending**: Approving sends the reply straight from Jelly, with your signature, exactly as if you'd typed
  it yourself.
- **Bulk confirmations**: Sign-up confirmation replies ("my favorite food is pizza!") get collected in one tab and
  confirmed all at once.
- **Knows when to ask you**: Drafts that need a careful look are flagged, like when a fact isn't in your docs, a
  teammate is assigned, or someone sent an attachment.
- **Rewrite on request**: Tell it "shorter" or "mention the deadline" and it tries again.
- **Quick and cheap**: It remembers what it has already seen, so it only spends time (and AI credits) on new emails.
- **Careful by default**: It won't send if someone already replied, a teammate has a draft open, or the conversation
  changed. There's also a kill switch.

## How it works

1. Pudding checks the inbox for emails nobody has answered yet.
2. It skips anything that doesn't need a reply, like auto-replies, bounces and newsletters.
3. It writes a draft for the rest, using your docs in `knowledge/` and your team's past replies.
4. You review the drafts at `localhost:4545` and approve, rewrite or discard each one.

## Running it

```bash
npm install
cp .env.example .env   # add your Marmalade and OpenAI (or Anthropic) keys
npm start
```

Every setting is explained in [`.env.example`](.env.example).

# Tech Stack

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-5FA04E?style=flat&logo=nodedotjs&logoColor=white) ![React](https://img.shields.io/badge/React-61DAFB?style=flat&logo=react&logoColor=black) ![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=flat&logo=tailwindcss&logoColor=white) ![Radix UI](https://img.shields.io/badge/Radix_UI-161618?style=flat&logo=radixui&logoColor=white) ![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white) ![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat&logo=sqlite&logoColor=white) ![OpenAI](https://img.shields.io/badge/OpenAI-412991?style=flat) ![Claude](https://img.shields.io/badge/Claude-D97757?style=flat&logo=claude&logoColor=white)

## Acknowledgements

**Jelly**: Pudding sends replies through [Jelly](https://letsjelly.com), the shared inbox it was built around.

**Marmalade**: Emails are read through Marmalade, a read-only copy of the Jelly inbox.

**shadcn/ui and Radix UI**: The dashboard is built with components in the style of [shadcn/ui](https://ui.shadcn.com),
on top of [Radix UI](https://www.radix-ui.com).

A huge thank you to all open-source contributors whose work makes this project possible!

### Why'd ya make this?

I'm the Event Manager for Haven at Hack Club, and the Haven inbox fills up fast. Most emails ask the same few things:
where's the venue, do I need a laptop, here's my favorite food to confirm my sign-up. Answering each one by hand in
Jelly took ages, so I made Pudding to write the replies for me and let me send them in a click. Jelly sucks, pudding
is better.

Thank you for visiting and supporting my work!

Feel free to connect with me via my website [Daamin Ashai](https://daamin.tech) or reach out through my social handles
for any queries or collaboration opportunities!
