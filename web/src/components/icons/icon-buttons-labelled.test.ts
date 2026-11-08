import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// EVERY ICON-ONLY BUTTON HAS A NAME. A `<button>` or `<Button>` whose only child is an `<Icon />` has no
// text a screen reader could read, so its opening tag must carry `aria-label`, `aria-labelledby` or
// `title`. This reads the .tsx sources as text, which is cheap and has these limits, stated so nobody
// trusts it for more than it does:
//
//   - It finds a button by its tag name (`button` or `Button`) and takes the text up to the first
//     closing tag of the same name. A button nested inside another button would fool it; none exists.
//   - It flags only the plain shape: the children are one `<Icon ... />` and nothing else (white space
//     aside). An icon wrapped in a span, in `{cond && ...}`, or beside an `sr-only` text is not
//     judged here, and a button whose name arrives through a spread (`{...props}`) counts as
//     unlabelled, because the text cannot show what the spread holds.
//   - The label is looked for in the button's opening tag, so `aria-label={t("...")}` and a literal
//     both pass. Whether the string is a good name is a review question.
//   - Tests and the playground are not read.
//
// A false negative is possible, a false positive is not today: the cases below pin the reader itself.

const SRC = resolve(import.meta.dirname, "../..");

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "playground") continue;
      found.push(...sources(path));
      continue;
    }
    if (!entry.name.endsWith(".tsx") || entry.name.endsWith(".test.tsx")) continue;
    found.push(path);
  }
  return found;
}

/** Where an opening tag starting at `from` ends: the index just past its `>`, and whether it closes itself (`/>`). Braces and quotes are skipped. */
function openingTag(text: string, from: number): { end: number; selfClosing: boolean } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === "`" && depth > 0)) quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return { end: i + 1, selfClosing: text.charAt(i - 1) === "/" };
  }
  return null;
}

const LABEL = /\baria-label(?:ledby)?\s*=|\btitle\s*=/;

/** True when `children` is one self-closing `<Icon ... />` and nothing after it. */
function isOnlyIcon(children: string): boolean {
  if (!/^<Icon\b/.test(children)) return false;
  const tag = openingTag(children, 0);
  return tag !== null && tag.selfClosing && tag.end === children.length;
}

interface Finding {
  file: string;
  line: number;
  tag: string;
}

/** The icon-only buttons of one source text that carry no label. */
function unlabelledIconButtons(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const match of text.matchAll(/<(button|Button)\b/g)) {
    const tag = match[1] ?? "";
    const start = match.index;
    const head = openingTag(text, start);
    if (head === null || head.selfClosing) continue;
    const opened = head.end;
    const closed = text.indexOf(`</${tag}>`, opened);
    if (closed < 0) continue;
    const children = text.slice(opened, closed).trim();
    if (!isOnlyIcon(children)) continue;
    if (LABEL.test(text.slice(start, opened))) continue;
    findings.push({ file, line: text.slice(0, start).split("\n").length, tag });
  }
  return findings;
}

describe("the reader", () => {
  it("flags an icon-only button with no name", () => {
    const text = `<Button size="icon" onClick={() => go()}>\n  <Icon name="close" className="size-4" />\n</Button>`;
    expect(unlabelledIconButtons("x.tsx", text)).toEqual([{ file: "x.tsx", line: 1, tag: "Button" }]);
  });

  it("passes a button named by aria-label, aria-labelledby or title", () => {
    expect(unlabelledIconButtons("x.tsx", `<button aria-label={t("close")}><Icon name="close" /></button>`)).toEqual([]);
    expect(unlabelledIconButtons("x.tsx", `<button aria-labelledby="a"><Icon name="close" /></button>`)).toEqual([]);
    expect(unlabelledIconButtons("x.tsx", `<button title="Close"><Icon name="close" /></button>`)).toEqual([]);
  });

  it("does not flag an icon beside another element", () => {
    expect(unlabelledIconButtons("x.tsx", `<button><Icon name="folder" /><Badge /></button>`)).toEqual([]);
  });

  it("does not flag a button that has text beside the icon, or an arrow in a prop", () => {
    expect(unlabelledIconButtons("x.tsx", `<Button onClick={() => go()}><Icon name="close" />Close</Button>`)).toEqual([]);
    expect(unlabelledIconButtons("x.tsx", `<Button onClick={() => go()}><Icon name="close" /><span className="sr-only">Close</span></Button>`)).toEqual([]);
  });
});

describe("every icon-only button in web/src", () => {
  it("carries aria-label, aria-labelledby or title", () => {
    const findings = sources(SRC).flatMap((file) => unlabelledIconButtons(relative(SRC, file), readFileSync(file, "utf8")));
    expect(findings).toEqual([]);
  });
});
