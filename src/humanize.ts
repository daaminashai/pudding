// Catches the things that make an email read as AI-written. A draft with any of
// these is sent back to the model once with the list; whatever survives is
// shown on the draft as a flag.

const PHRASES: Array<[RegExp, string]> = [
  [/\bi hope (this|my) (e-?mail|message|note) finds you\b/i, '"I hope this email finds you…"'],
  [/\bi hope (this|that) helps\b/i, '"I hope this helps"'],
  [/\b(great|good|excellent) question\b/i, '"great question"'],
  [/\bthanks? (you )?(so much )?for reaching out\b/i, '"thanks for reaching out"'],
  [/\bfeel free to (reach out|contact|get in touch|let us know|ask)\b/i, '"feel free to reach out"'],
  [/\bdon'?t hesitate to\b/i, '"don\'t hesitate to"'],
  [/\bplease let (me|us) know if you have any (other|further|more) questions\b/i, '"let me know if you have any other questions"'],
  [/^\s*(certainly|absolutely|of course)[!,.]/im, "opens with Certainly/Absolutely/Of course"],
  [/\bi'?d be (happy|glad|delighted) to\b/i, '"I\'d be happy to"'],
  [/\brest assured\b/i, '"rest assured"'],
  [/\bi (completely |totally )?understand (your|the) (concern|frustration)\b/i, '"I understand your concern"'],
  [/\bdelve\b/i, '"delve"'],
  [/\bseamless(ly)?\b/i, '"seamless"'],
  [/\bin (summary|conclusion)\b/i, '"in summary"'],
];

export function findAiTells(text: string): string[] {
  const tells: string[] = [];
  if (/[—]/.test(text)) tells.push("em dash (—)");
  if (/ – /.test(text)) tells.push("spaced en dash ( – )");
  if (/\*\*[^*]+\*\*|__[^_]+__/.test(text)) tells.push("markdown bold");
  if (/^\s{0,3}#{1,6}\s/m.test(text)) tells.push("markdown heading");
  if (/^\s*[-*•]\s+\S/m.test(text)) tells.push("bullet list");
  if (/^\s*\d+[.)]\s+\S/m.test(text)) tells.push("numbered list");
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) tells.push("markdown link");
  for (const [re, label] of PHRASES) {
    if (re.test(text)) tells.push(label);
  }
  return tells;
}
