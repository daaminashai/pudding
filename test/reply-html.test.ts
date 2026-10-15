// The link markup here is copied from replies the team sent by hand in Jelly.
import { describe, expect, it } from "vitest";
import { plainReply, textToHtml } from "../src/reply-html.js";
import { htmlToText } from "../src/thread.js";

describe("reply text to Jelly's HTML", () => {
  it("escapes the reply and keeps blank lines", () => {
    expect(textToHtml("hey <b>you</b> & co\n\nbye")).toBe("<div>hey &lt;b&gt;you&lt;/b&gt; &amp; co</div><div><br></div><div>bye</div>");
  });

  it("links email addresses with mailto, showing the address", () => {
    expect(textToHtml("send an email to san-francisco@haven.hackclub.com for updates.")).toBe(
      '<div>send an email to <a href="mailto:san-francisco@haven.hackclub.com">san-francisco@haven.hackclub.com</a> for updates.</div>',
    );
  });

  it("links web addresses as written, adding https:// to the link when it's left off", () => {
    expect(textToHtml("Please keep an eye on gas.hackclub.com as it’s expected to re-open soon.")).toBe(
      '<div>Please keep an eye on <a href="https://gas.hackclub.com">gas.hackclub.com</a> as it’s expected to re-open soon.</div>',
    );
    expect(textToHtml("book time at https://booking.haven.hackclub.com - but for now")).toBe(
      '<div>book time at <a href="https://booking.haven.hackclub.com">https://booking.haven.hackclub.com</a> - but for now</div>',
    );
  });

  it("links a few words with [words](url)", () => {
    expect(textToHtml("joining the [#haven-sf](https://hackclub.enterprise.slack.com/archives/C0BN7TZJGG7) channel")).toBe(
      '<div>joining the <a href="https://hackclub.enterprise.slack.com/archives/C0BN7TZJGG7">#haven-sf</a> channel</div>',
    );
    expect(textToHtml("[apply here](haven.hackclub.com/apply)")).toBe(
      '<div><a href="https://haven.hackclub.com/apply">apply here</a></div>',
    );
  });

  it("leaves punctuation around a link out of it", () => {
    expect(textToHtml("check https://haven.hackclub.com/mirpurkhas. For anything else")).toBe(
      '<div>check <a href="https://haven.hackclub.com/mirpurkhas">https://haven.hackclub.com/mirpurkhas</a>. For anything else</div>',
    );
    expect(textToHtml("(or start one at hack.club/organize-haven), or email london@haven.hackclub.com.")).toBe(
      '<div>(or start one at <a href="https://hack.club/organize-haven">hack.club/organize-haven</a>), or email ' +
        '<a href="mailto:london@haven.hackclub.com">london@haven.hackclub.com</a>.</div>',
    );
  });

  it("escapes links and leaves file names and versions alone", () => {
    expect(textToHtml("https://x.org/?a=1&b=2")).toBe('<div><a href="https://x.org/?a=1&amp;b=2">https://x.org/?a=1&amp;b=2</a></div>');
    expect(textToHtml("Node.js, index.html and Godot 4.3")).toBe("<div>Node.js, index.html and Godot 4.3</div>");
  });

  it("writes [words](url) out in plain text for pasting", () => {
    expect(plainReply("join [#haven-sf](https://x.org/c) or email a@x.org")).toBe("join #haven-sf (https://x.org/c) or email a@x.org");
  });
});

describe("links in past replies", () => {
  it("reads them back the way a reply would write them", () => {
    const sent =
      '<div>I’d recommend joining the <a href="https://hackclub.enterprise.slack.com/archives/C0BN7TZJGG7">#haven-sf</a> ' +
      'channel, or send an email to <a href="mailto:san-francisco@haven.hackclub.com">san-francisco@haven.hackclub.com</a>.' +
      '<br></div><div>Keep an eye on <a href="https://gas.hackclub.com">gas.hackclub.com</a>, and ' +
      '<a href="https://hcb.hackclub.com/hq">financially transparent<span>&nbsp;</span></a> too.</div>';
    const text = htmlToText(sent);
    expect(text).toBe(
      "I’d recommend joining the [#haven-sf](https://hackclub.enterprise.slack.com/archives/C0BN7TZJGG7) channel, " +
        "or send an email to san-francisco@haven.hackclub.com.\n\n" +
        "Keep an eye on gas.hackclub.com, and [financially transparent](https://hcb.hackclub.com/hq) too.",
    );
    // Sending that text again makes the same links.
    const links = (html: string) => html.match(/<a [^>]*>.*?<\/a>/g)?.map((a) => a.replace(/<span>&nbsp;<\/span>/, ""));
    expect(links(textToHtml(text))).toEqual(links(sent));
  });
});
