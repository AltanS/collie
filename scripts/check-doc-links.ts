#!/usr/bin/env bun
// Link-integrity checker for tracked markdown files.
//
//   bun scripts/check-doc-links.ts
//
// Walks every `*.md` file tracked by git, extracts inline markdown links, and checks that
// local (non-http) targets resolve: the file exists, and — if the link has a `#anchor` — the
// anchor matches a heading slug or an explicit HTML anchor in the target file.
//
// Exit 0 clean. Exit 1 with one line per failure: `path:line  <link>  — reason`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

const EXCLUDED = ["node_modules/", "web/dist/", ".tracker/"];

function listMarkdownFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "*.md"]);
  const files = out.stdout.toString().trim().split("\n").filter(Boolean);
  return files.filter((f) => !EXCLUDED.some((ex) => f.startsWith(ex) || f.includes(`/${ex}`)));
}

// Strips inline markdown formatting from heading text before slugging, so `**bold**` slugs the
// same as `bold`. Order matters: unwrap links first (they may contain `` ` `` or `*`), then code
// spans, then emphasis — otherwise e.g. `` `*x*` `` would have its backticks stripped before the
// asterisks are visible to the emphasis regex.
function stripInlineFormatting(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1");
}

// GitHub's heading slug rule: lowercase, drop anything that isn't a letter/digit/space/hyphen/
// underscore, then turn spaces into hyphens. The drop step runs BEFORE the space-to-hyphen step,
// so a punctuation character sitting between two spaces (e.g. "a — b") leaves behind TWO spaces,
// which become TWO hyphens ("a--b"), not one. That double-hyphen is real GitHub behaviour, not a
// bug — don't "fix" it by collapsing runs of hyphens.
function slugify(text: string): string {
  const cleaned = stripInlineFormatting(text).trim().toLowerCase();
  return cleaned.replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
}

type FileAnchors = { headingSlugs: Set<string>; htmlAnchors: Set<string> };

// Reads a file's lines with fenced-code-block state tracked, so callers (heading extraction,
// link extraction) can both skip ```...``` bodies without re-implementing the fence toggle.
function eachLine(content: string, fn: (line: string, lineNo: number, inFence: boolean) => void) {
  let inFence = false;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fn(line, i + 1, inFence);
      inFence = !inFence;
      continue;
    }
    fn(line, i + 1, inFence);
  }
}

const anchorCache = new Map<string, FileAnchors>();

function getAnchors(path: string): FileAnchors {
  const cached = anchorCache.get(path);
  if (cached) return cached;
  const headingSlugs = new Set<string>();
  const htmlAnchors = new Set<string>();
  const seenBase = new Map<string, number>();
  const content = readFileSync(path, "utf8");
  eachLine(content, (line, _lineNo, inFence) => {
    if (inFence) return;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const base = slugify(heading[2].replace(/#+\s*$/, ""));
      const count = seenBase.get(base) ?? 0;
      seenBase.set(base, count + 1);
      headingSlugs.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const m of line.matchAll(/<a\s[^>]*name=["']([^"']+)["']/gi)) htmlAnchors.add(m[1]);
    for (const m of line.matchAll(/\bid=["']([^"']+)["']/gi)) htmlAnchors.add(m[1]);
  });
  const result = { headingSlugs, htmlAnchors };
  anchorCache.set(path, result);
  return result;
}

// Percent-decodes an anchor for comparison (e.g. `%EF%B8%8F` -> the emoji variation selector).
// Falls back to the raw string if decoding fails (malformed escapes aren't our problem to reject).
function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
}

function anchorMatches(anchor: string, anchors: FileAnchors): boolean {
  const candidates = new Set([anchor, decodeAnchor(anchor), anchor.toLowerCase(), decodeAnchor(anchor).toLowerCase()]);
  for (const c of candidates) {
    if (anchors.headingSlugs.has(c) || anchors.htmlAnchors.has(c)) return true;
  }
  return false;
}

type Failure = { file: string; line: number; link: string; reason: string };

function checkFile(file: string, failures: Failure[]) {
  const content = readFileSync(file, "utf8");
  const dir = dirname(file);
  eachLine(content, (line, lineNo, inFence) => {
    if (inFence) return;
    // Inline links only: `[text](target)`, not preceded by `!` (that's an image).
    for (const m of line.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = m[1].trim().split(/\s+/)[0]; // drop an optional `"title"` after the target
      if (/^(https?:|mailto:|#!)/.test(raw)) continue;

      const hashIdx = raw.indexOf("#");
      const pathPart = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
      const anchor = hashIdx === -1 ? null : raw.slice(hashIdx + 1);

      const targetFile = pathPart === "" ? file : resolve(dir, pathPart);
      if (!existsSync(targetFile)) {
        failures.push({ file, line: lineNo, link: raw, reason: "missing file" });
        continue;
      }
      if (anchor !== null && anchor !== "") {
        const anchors = getAnchors(targetFile);
        if (!anchorMatches(anchor, anchors)) {
          failures.push({ file, line: lineNo, link: raw, reason: "missing anchor" });
        }
      }
    }
  });
}

function main() {
  const files = listMarkdownFiles();
  const failures: Failure[] = [];
  for (const file of files) checkFile(file, failures);

  if (failures.length === 0) {
    console.log(`checked ${files.length} markdown files, all links OK`);
    process.exit(0);
  }
  for (const f of failures) {
    console.log(`${relative(".", f.file)}:${f.line}  ${f.link}  — ${f.reason}`);
  }
  console.log(`\n${failures.length} broken link(s) in ${files.length} files checked`);
  process.exit(1);
}

main();
