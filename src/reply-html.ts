// A reply's plain text to the HTML Jelly's editor makes, with links done the
// way the team's own replies do them:
//   san-francisco@haven.hackclub.com -> <a href="mailto:san-francisco@haven.hackclub.com">san-francisco@haven.hackclub.com</a>
//   gas.hackclub.com                 -> <a href="https://gas.hackclub.com">gas.hackclub.com</a>
//   [#haven-sf](https://…)           -> <a href="https://…">#haven-sf</a>
// No Node imports: the dashboard uses this too, so copied replies paste with links.

// Bare domains only count with one of these endings, so "Node.js" or "index.html" stay text.
const TLDS = "com|org|net|edu|gov|io|co|club|dev|app|ai|gg|xyz|info|uk|ca";
const EMAIL = String.raw`[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}`;
const URL = String.raw`https?:\/\/[^\s<>"]+`;
const DOMAIN = String.raw`(?:[a-z0-9-]+\.)+(?:${TLDS})\b(?:\/[^\s<>"]*)?`;
const MARKDOWN = String.raw`\[([^\]\n]+)\]\((${URL}|mailto:${EMAIL}|${DOMAIN})\)`;

const MARKDOWN_RE = new RegExp(MARKDOWN, "gi");
const LINK_RE = new RegExp(`${MARKDOWN}|(${EMAIL})|(${URL})|(?<![\\w.@/-])(${DOMAIN})`, "gi");

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function anchor(href: string, text: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

/** "https://x.org/a." -> ["https://x.org/a", "."]: punctuation ending a sentence isn't part of the link. */
function splitTrailing(link: string): [string, string] {
  let end = link.length;
  while (end > 0) {
    const c = link[end - 1]!;
    const head = link.slice(0, end);
    const unbalanced = c === ")" && head.split("(").length < head.split(")").length;
    if (!".,;:!?'\"’]".includes(c) && !unbalanced) break;
    end--;
  }
  return [link.slice(0, end), link.slice(end)];
}

function withScheme(link: string): string {
  return /^(https?:\/\/|mailto:)/i.test(link) ? link : `https://${link}`;
}

function linkify(line: string): string {
  let html = "";
  let last = 0;
  for (const m of line.matchAll(LINK_RE)) {
    const [whole, label, target, email, url, domain] = m;
    html += escapeHtml(line.slice(last, m.index));
    last = m.index + whole.length;
    if (label !== undefined && target !== undefined) html += anchor(withScheme(target), label);
    else if (email !== undefined) html += anchor(`mailto:${email}`, email);
    else {
      const [link, after] = splitTrailing(url ?? domain ?? "");
      html += (link ? anchor(withScheme(link), link) : "") + escapeHtml(after);
    }
  }
  return html + escapeHtml(line.slice(last));
}

/** One <div> per line, <div><br></div> for blank lines, links as <a>. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? "<div><br></div>" : `<div>${linkify(line)}</div>`))
    .join("");
}

/** The reply as plain text, for pasting where links can't be: [text](url) becomes "text (url)". */
export function plainReply(text: string): string {
  return text.replace(MARKDOWN_RE, (_, label: string, target: string) =>
    label === target ? label : `${label} (${target})`,
  );
}
