#!/usr/bin/env bun
// The docs' placeholder check (`README.md` and `docs/*.md`).
//
//   bun scripts/check-docs-placeholders.ts
//
// Exit 0 when the docs are clean. Exit 1 with one line per finding: `file:line: <text>`.
//
// Why: a placeholder such as `<repo>` or `<old lead>` written in plain prose, outside a code span and
// outside a fenced code block, is HTML to every Markdown renderer. On GitHub it vanishes from the
// page. On the project's website the docs parser drops the rest of the paragraph when a line starts
// with one. The fix is a code span: `<repo>`.
//
// What is skipped (it is code, not prose): fenced code blocks (``` and ~~~, with an info string),
// indented code blocks, inline code spans (single and multiple backticks), HTML comments, a
// backslash-escaped `\<`, an autolink (`<https://example.com>`, `<mailto:...>`, `<name@host.tld>`)
// and a tag whose name is on the allow-list below (real HTML that the docs use on purpose).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DocFile {
  /** Path from the repository root, for example `docs/hill.md`. */
  name: string;
  text: string;
}

export interface Finding {
  file: string;
  line: number;
  text: string;
}

/** Real HTML the docs use on purpose. A tag named here is never a finding. */
export const ALLOWED_TAGS = {
  a: "an anchor around a bold lead or an image",
  b: "bold inside an HTML table cell, where Markdown does not run",
  br: "a hard line break inside a table cell",
  code: "a code span inside an HTML table cell, where Markdown does not run",
  img: "a screenshot with a width, which a Markdown image cannot carry",
  p: "a centred paragraph around an image",
  sub: "a small caption under a screenshot",
  table: "the screenshot grid in the README, which Markdown cannot draw",
  thead: "part of an HTML table",
  tbody: "part of an HTML table",
  tr: "part of an HTML table",
  th: "part of an HTML table",
  td: "part of an HTML table",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Findings that stay. Each names the file, the exact finding text and the reason. A heading is
 * listed here only when an anchor link in the repo points at its slug, so a code span would break
 * the link.
 */
export const EXCEPTIONS: readonly { file: string; text: string; reason: string }[] = [];

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const AUTOLINK = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>$/;
const TAG = /<\/?[A-Za-z][^<>]*>/g;

interface Row {
  line: number;
  text: string;
}

/** The prose rows of a file: fenced and indented code blocks are removed, their lines stay blank. */
function proseRows(text: string): Row[] {
  const rows: Row[] = [];
  let fence: { char: string; size: number } | undefined;
  let inList = false;
  let previousBlank = true;
  let inIndentedCode = false;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    const open = FENCE.exec(raw);
    if (fence !== undefined) {
      const marker = open?.[1] ?? "";
      const closes = marker.startsWith(fence.char) && marker.length >= fence.size && (open?.[2] ?? "").trim() === "";
      if (closes) fence = undefined;
      rows.push({ line, text: "" });
      continue;
    }
    if (open !== null) {
      const marker = open[1] ?? "```";
      // An info string after a backtick fence cannot hold a backtick; then it is a code span, not a fence.
      if (!(marker.startsWith("`") && (open[2] ?? "").includes("`"))) {
        fence = { char: marker.charAt(0), size: marker.length };
        rows.push({ line, text: "" });
        previousBlank = false;
        continue;
      }
    }
    const blank = raw.trim() === "";
    if (blank) {
      rows.push({ line, text: "" });
      previousBlank = true;
      continue;
    }
    const indent = /^[ \t]*/.exec(raw)?.[0] ?? "";
    const deep = indent.includes("\t") || indent.length >= 4;
    if (!deep) {
      inList = LIST_ITEM.test(raw);
      inIndentedCode = false;
    }
    if (deep && !inList && (previousBlank || inIndentedCode)) {
      inIndentedCode = true;
      rows.push({ line, text: "" });
      previousBlank = false;
      continue;
    }
    rows.push({ line, text: raw });
    previousBlank = false;
  }
  return rows;
}

/** Replace every inline code span of a paragraph with spaces (newlines stay), so offsets hold. */
function maskCodeSpans(paragraph: string): string {
  let result = "";
  let index = 0;
  while (index < paragraph.length) {
    const char = paragraph.charAt(index);
    if (char === "\\") {
      result += paragraph.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char !== "`") {
      result += char;
      index += 1;
      continue;
    }
    let size = 1;
    while (paragraph.charAt(index + size) === "`") size += 1;
    // The closing run is a run of the same length, no longer and no shorter.
    let search = index + size;
    let close = -1;
    while (search < paragraph.length) {
      const next = paragraph.indexOf("`", search);
      if (next === -1) break;
      let run = 1;
      while (paragraph.charAt(next + run) === "`") run += 1;
      if (run === size) {
        close = next;
        break;
      }
      search = next + run;
    }
    if (close === -1) {
      result += paragraph.slice(index, index + size);
      index += size;
      continue;
    }
    const end = close + size;
    result += paragraph.slice(index, end).replace(/[^\n]/g, " ");
    index = end;
  }
  return result;
}

function maskComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
}

function tagName(tag: string): string {
  return (/^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag)?.[1] ?? "").toLowerCase();
}

/** Every placeholder-looking tag of one Markdown text, outside code. */
export function findPlaceholders(text: string): { line: number; text: string }[] {
  const rows = proseRows(text);
  // Code spans are masked per paragraph (a span may cross a line break, never a blank line).
  const masked: string[] = [];
  let paragraph: Row[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    const lines = maskCodeSpans(paragraph.map((row) => row.text).join("\n")).split("\n");
    masked.push(...lines);
    paragraph = [];
  };
  for (const row of rows) {
    if (row.text.trim() === "") {
      flush();
      masked.push("");
      continue;
    }
    paragraph.push(row);
  }
  flush();
  const joined = maskComments(masked.join("\n"));
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of joined.split("\n")) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const found: { line: number; text: string }[] = [];
  for (const match of joined.matchAll(TAG)) {
    const tag = match[0];
    const at = match.index ?? 0;
    if (joined.charAt(at - 1) === "\\") continue;
    if (AUTOLINK.test(tag)) continue;
    if (Object.hasOwn(ALLOWED_TAGS, tagName(tag))) continue;
    let line = 0;
    while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? Infinity) <= at) line += 1;
    found.push({ line: line + 1, text: tag.replace(/\s+/g, " ") });
  }
  return found;
}

/** Every finding over the doc files, with the listed exceptions removed. */
export function checkDocs(files: readonly DocFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    for (const hit of findPlaceholders(file.text)) {
      const excused = EXCEPTIONS.some((entry) => entry.file === file.name && entry.text === hit.text);
      if (excused) continue;
      findings.push({ file: file.name, line: hit.line, text: hit.text });
    }
  }
  return findings;
}

/** `README.md` and `docs/*.md` of a repository root. */
export function readDocs(root: string): DocFile[] {
  const names = ["README.md", ...readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")).toSorted().map((name) => `docs/${name}`)];
  return names.map((name): DocFile => ({ name, text: readFileSync(join(root, name), "utf8") }));
}

function main(): void {
  const files = readDocs(join(import.meta.dir, ".."));
  const findings = checkDocs(files);
  if (findings.length === 0) {
    console.log(`check-docs-placeholders: ${files.length} files, all clean`);
    return;
  }
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.text}`);
  console.error(`check-docs-placeholders: ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
  process.exit(1);
}

if (import.meta.main) main();
