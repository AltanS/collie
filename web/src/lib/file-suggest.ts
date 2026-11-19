import { SUGGEST_LIMIT, type Suggestion } from "./sent-suggest";
import type { FileEntry } from "./types";

/** Maximum displayed characters on a file chip before compacting leading folder segments. */
const MAX_FILE_CHIP_CHARS = 28;

const AT_BEFORE_CARET = /(?:^|\s)@(\S*)$/u;
const HAS_WHITESPACE = /\s/u;

export interface AtToken {
  /** Index of `@` in the draft. */
  start: number;
  /** End index of the contiguous `@\S*` token in the draft. */
  end: number;
  /** Characters between `@` and the caret. */
  raw: string;
}

export interface ResolvedAtQuery {
  /** Folder relative to the Files root (`""` is the root), suitable for `?dir=`. */
  apiDir: string;
  /** Folder prefix relative to the pane's `cwd` (`""` or ending with `/`). */
  insertPrefix: string;
  /** Filename filter typed after the last `/`. */
  query: string;
}

export interface FileSuggestion {
  key: string;
  ariaLabel: string;
  display: Suggestion;
  /** `@`-prefixed path relative to `pane.cwd` (`/` suffix on folders, no trailing space). */
  insert: string;
  isDir: boolean;
}

/**
 * Finds an active `@` token ending at `caret` (when the selection is collapsed). Returns `null` when
 * `caret` is `null` or negative, when `@` sits inside a word (an email address), or after a space.
 */
export function findAtToken(text: string, caret: number | null): AtToken | null {
  if (caret === null || caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const match = AT_BEFORE_CARET.exec(before);
  if (match === null) return null;
  const raw = match[1] ?? "";
  const start = caret - raw.length - 1;
  let end = caret;
  while (end < text.length && !HAS_WHITESPACE.test(text[end] ?? "")) end += 1;
  return { start, end, raw };
}

/**
 * Resolves `@<raw>` typed in a pane whose `cwd` sits at `baseDir` under the Files root into the
 * bridge's `?dir=` argument (`apiDir`), the `cwd`-relative insertion prefix, and the leaf filter.
 * Returns `null` when the path climbs above the Files root, names `.git`, or uses invalid characters.
 */
export function resolveAtQuery(raw: string, baseDir: string): ResolvedAtQuery | null {
  if (raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) return null;
  const baseParts = baseDir === "" ? [] : baseDir.split("/");
  if (baseParts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    return null;
  }
  const slash = raw.lastIndexOf("/");
  const dirInput = slash === -1 ? "" : raw.slice(0, slash);
  const query = slash === -1 ? raw : raw.slice(slash + 1);
  if (query.toLowerCase() === ".git") return null;

  const targetParts = [...baseParts];
  if (slash !== -1) {
    for (const part of dirInput.split("/")) {
      if (part === "" || part.toLowerCase() === ".git") return null;
      if (part === ".") continue;
      if (part === "..") {
        if (targetParts.length === 0) return null;
        targetParts.pop();
      } else {
        targetParts.push(part);
      }
    }
  }

  let common = 0;
  while (common < baseParts.length && common < targetParts.length && baseParts[common] === targetParts[common]) {
    common += 1;
  }
  const relParts: string[] = [];
  for (let i = common; i < baseParts.length; i += 1) relParts.push("..");
  for (let i = common; i < targetParts.length; i += 1) relParts.push(targetParts[i]!);

  return {
    apiDir: targetParts.join("/"),
    insertPrefix: relParts.length === 0 ? "" : `${relParts.join("/")}/`,
    query,
  };
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  const fa = a.kind === "dir" ? 0 : 1;
  const fb = b.kind === "dir" ? 0 : 1;
  if (fa !== fb) return fa - fb;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function subsequenceMarks(lower: string, queryLower: string): [number, number][] | null {
  const spans: [number, number][] = [];
  let cursor = 0;
  for (let i = 0; i < queryLower.length; i += 1) {
    const ch = queryLower[i]!;
    const found = lower.indexOf(ch, cursor);
    if (found === -1) return null;
    const prev = spans.at(-1);
    if (prev !== undefined && prev[1] === found) prev[1] = found + 1;
    else spans.push([found, found + 1]);
    cursor = found + 1;
  }
  return spans;
}

function shiftMarks(
  marks: readonly (readonly [number, number])[],
  offset: number,
  minIndex: number,
  maxIndex: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (const [start, end] of marks) {
    const s = Math.max(minIndex, start + offset);
    const e = Math.min(maxIndex, end + offset);
    if (s < e) out.push([s, e]);
  }
  return out;
}

function buildDisplay(
  ariaLabel: string,
  insertPrefix: string,
  nameSuffix: string,
  nameMarks: readonly (readonly [number, number])[],
): Suggestion {
  if (ariaLabel.length <= MAX_FILE_CHIP_CHARS) {
    const offset = 1 + insertPrefix.length;
    return {
      line: ariaLabel,
      marks: shiftMarks(nameMarks, offset, 0, ariaLabel.length),
    };
  }
  if (insertPrefix !== "") {
    const dirs = insertPrefix.slice(0, -1).split("/");
    const kept: string[] = [];
    for (let i = dirs.length - 1; i >= 0; i -= 1) {
      const candidate = `@…/${[dirs[i]!, ...kept].join("/")}/${nameSuffix}`;
      if (candidate.length > MAX_FILE_CHIP_CHARS) break;
      kept.unshift(dirs[i]!);
    }
    const head = kept.length > 0 ? `@…/${kept.join("/")}/` : "@…/";
    const candidate = `${head}${nameSuffix}`;
    if (candidate.length <= MAX_FILE_CHIP_CHARS) {
      return {
        line: candidate,
        marks: shiftMarks(nameMarks, head.length, head.length, candidate.length),
      };
    }
  }
  const keepCount = MAX_FILE_CHIP_CHARS - 2;
  let cut = nameSuffix.length - keepCount;
  const code = nameSuffix.charCodeAt(cut);
  if (cut < nameSuffix.length && code >= 0xdc00 && code <= 0xdfff) cut += 1;
  const line = `@…${nameSuffix.slice(cut)}`;
  return {
    line,
    marks: shiftMarks(nameMarks, 2 - cut, 2, line.length),
  };
}

function toFileSuggestion(
  entry: FileEntry,
  insertPrefix: string,
  nameMarks: readonly (readonly [number, number])[],
): FileSuggestion {
  const isDir = entry.kind === "dir";
  const nameSuffix = isDir ? `${entry.name}/` : entry.name;
  const insert = `@${insertPrefix}${nameSuffix}`;
  return {
    key: insert,
    ariaLabel: insert,
    display: buildDisplay(insert, insertPrefix, nameSuffix, nameMarks),
    insert,
    isDir,
  };
}

/**
 * Filters and ranks one folder's entries for `@<insertPrefix><query>`: hides git-ignored entries and
 * whitespace-containing names (which split an unquoted `@` token), puts folders first on an empty
 * query, and ranks exact → prefix → substring → fuzzy subsequence matches with shorter names preferred.
 */
export function suggestFiles(
  entries: readonly FileEntry[],
  insertPrefix: string,
  query: string,
  limit: number = SUGGEST_LIMIT,
): FileSuggestion[] {
  const visible = entries.filter((entry) => entry.ignored !== true && !HAS_WHITESPACE.test(entry.name));
  if (query === "") {
    return visible
      .toSorted(compareEntries)
      .slice(0, limit)
      .map((entry) => toFileSuggestion(entry, insertPrefix, []));
  }

  const q = query.toLowerCase();
  const ranked: { entry: FileEntry; tier: 0 | 1 | 2 | 3; marks: readonly (readonly [number, number])[] }[] = [];
  for (const entry of visible) {
    const lower = entry.name.toLowerCase();
    if (lower === q) {
      ranked.push({ entry, tier: 0, marks: [[0, q.length]] });
      continue;
    }
    if (lower.startsWith(q)) {
      ranked.push({ entry, tier: 1, marks: [[0, q.length]] });
      continue;
    }
    const sub = lower.indexOf(q);
    if (sub > 0) {
      ranked.push({ entry, tier: 2, marks: [[sub, sub + q.length]] });
      continue;
    }
    const fuzzy = subsequenceMarks(lower, q);
    if (fuzzy !== null) {
      ranked.push({ entry, tier: 3, marks: fuzzy });
    }
  }

  return ranked
    .toSorted(
      (a, b) =>
        a.tier - b.tier ||
        (a.entry.kind === "dir" ? 0 : 1) - (b.entry.kind === "dir" ? 0 : 1) ||
        a.entry.name.length - b.entry.name.length ||
        compareEntries(a.entry, b.entry),
    )
    .slice(0, limit)
    .map(({ entry, marks }) => toFileSuggestion(entry, insertPrefix, marks));
}

export interface AppliedFileSuggestion {
  text: string;
  caret: number;
}

/**
 * Replaces `token` in `text` with `suggestion`. Picking a file appends a trailing space (consuming an
 * adjacent ASCII space so mid-sentence picks never leave two spaces), closing the active `@` token
 * without sending; picking a folder keeps `@folder/` open for the next segment.
 */
export function applyFileSuggestion(
  text: string,
  token: AtToken,
  suggestion: FileSuggestion,
): AppliedFileSuggestion {
  if (suggestion.isDir) {
    const next = `${text.slice(0, token.start)}${suggestion.insert}${text.slice(token.end)}`;
    return { text: next, caret: token.start + suggestion.insert.length };
  }
  const inserted = `${suggestion.insert} `;
  const afterEnd = text[token.end] === " " ? token.end + 1 : token.end;
  const next = `${text.slice(0, token.start)}${inserted}${text.slice(afterEnd)}`;
  return { text: next, caret: token.start + inserted.length };
}
