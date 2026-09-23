// The lazy half of the Changes view's syntax colour (ADR 0065 rule 7): sugar-high's core, its
// language modules, and the split of a hunk into its two sides. `diff-highlight.ts` reaches this file
// by dynamic import only, so none of it is in the main bundle.
//
// A diff row is one line out of context, and a line alone cannot say whether it sits inside a block
// comment or a template string. So each hunk is highlighted as its two files: the OLD side (context
// and deleted lines) and the NEW side (context and added lines), each as one text, and the tokens are
// split back onto the rows. A deleted row takes the old side's tokens, an added row the new side's,
// and a context row the side of the nearest changed row above it in the hunk (both sides agree
// before the first change). A row whose tokens do not spell its text exactly stays plain: colour
// never changes a glyph.

import { parse, type ParseOptions } from "sugar-high/core";

import type { RowTokens, SyntaxLang, SyntaxToken, Tokenizer } from "@/lib/diff-highlight";
import type { DiffRow } from "@/lib/unified-diff";

// Each import is a string literal, so the bundler gives each language its own small chunk. A module
// is typed as a bare object: its named exports ARE its parse options (sugar-high's own
// `presets/configs.js` passes the namespace as is), but the package's per-language `.d.ts` files
// disagree with `core.d.ts` on one callback's arity, so the spread below is what meets the type.
type LangModule = object;
const LOADERS = {
  typescript: () => import("sugar-high/lang/typescript"),
  javascript: () => import("sugar-high/lang/javascript"),
  json: () => import("sugar-high/lang/json"),
  css: () => import("sugar-high/lang/css"),
  html: () => import("sugar-high/lang/html"),
  markdown: () => import("sugar-high/lang/markdown"),
  python: () => import("sugar-high/lang/python"),
  go: () => import("sugar-high/lang/go"),
  rust: () => import("sugar-high/lang/rust"),
  shell: () => import("sugar-high/lang/shell"),
  yaml: () => import("sugar-high/lang/yaml"),
  toml: () => import("sugar-high/lang/toml"),
  c: () => import("sugar-high/lang/c"),
  cpp: () => import("sugar-high/lang/cpp"),
  csharp: () => import("sugar-high/lang/csharp"),
  java: () => import("sugar-high/lang/java"),
  kotlin: () => import("sugar-high/lang/kotlin"),
  lua: () => import("sugar-high/lang/lua"),
  php: () => import("sugar-high/lang/php"),
  ruby: () => import("sugar-high/lang/ruby"),
  sql: () => import("sugar-high/lang/sql"),
  swift: () => import("sugar-high/lang/swift"),
  zig: () => import("sugar-high/lang/zig"),
  dockerfile: () => import("sugar-high/lang/dockerfile"),
  hcl: () => import("sugar-high/lang/hcl"),
  graphql: () => import("sugar-high/lang/graphql"),
} satisfies Record<SyntaxLang, () => Promise<LangModule>>;

/** A language's module as the parse options it is; `LOADERS` keeps each module's own type. */
function loadModule(lang: SyntaxLang): Promise<LangModule> {
  return LOADERS[lang]();
}

/** The languages whose scanner is the JavaScript one and wants its JSX, regex and template modes. */
const JS_MODES = new Set<SyntaxLang>(["typescript", "javascript", "html"]);

const loaded = new Map<SyntaxLang, Promise<Tokenizer>>();

/**
 * The tokenizer for one language, loaded once. sugar-high's own `highlight` turns the JavaScript
 * modes off for every other language (`presets/configs.js`, `nonJavaScript`); this does the same, so
 * a `'` in Rust or a `/` in CSS is not read as a string or a regex.
 */
export function loadTokenizer(lang: SyntaxLang): Promise<Tokenizer> {
  let pending = loaded.get(lang);
  if (!pending) {
    pending = loadModule(lang).then((mod) => {
      const options: ParseOptions = JS_MODES.has(lang)
        ? { ...mod }
        : { ...mod, jsx: false, regex: false, templateStrings: false };
      return (code: string) => parse(code, options).lines.map((line) => line.tokens);
    });
    // A failed load (offline, a stale chunk) is forgotten, so the next diff tries again.
    pending.catch(() => loaded.delete(lang));
    loaded.set(lang, pending);
  }
  return pending;
}

type Side = "old" | "new";

/** A row's tokens, only when they spell its text exactly. */
function exact(tokens: readonly SyntaxToken[] | undefined, text: string): readonly SyntaxToken[] | null {
  const line = tokens ?? [];
  return line.map((t) => t.value).join("") === text ? line : null;
}

/**
 * Tokens per row, index for index with `rows`: null for a hunk header, a note, or a row that could
 * not be matched. Pure, so the side split is tested without a browser or a real highlighter.
 */
export function highlightRows(rows: readonly DiffRow[], tokenize: Tokenizer): RowTokens {
  const out: RowTokens = rows.map(() => null);
  let start = 0;
  while (start < rows.length) {
    let end = start + 1;
    while (end < rows.length && rows[end]!.kind !== "hunk") end++;
    highlightHunk(rows, start, end, tokenize, out);
    start = end;
  }
  return out;
}

function highlightHunk(
  rows: readonly DiffRow[],
  start: number,
  end: number,
  tokenize: Tokenizer,
  out: RowTokens,
) {
  const oldRows: { row: number; text: string }[] = [];
  const newRows: { row: number; text: string }[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i]!;
    if (row.kind === "context" || row.kind === "del") oldRows.push({ row: i, text: row.text });
    if (row.kind === "context" || row.kind === "add") newRows.push({ row: i, text: row.text });
  }
  const tokensOf = (side: { row: number; text: string }[]) => {
    const lines = side.length ? tokenize(side.map((r) => r.text).join("\n")) : [];
    return new Map(side.map((r, n) => [r.row, lines[n]]));
  };
  const old = tokensOf(oldRows);
  const neu = tokensOf(newRows);

  let side: Side = "new";
  for (let i = start; i < end; i++) {
    const row = rows[i]!;
    if (row.kind === "del") side = "old";
    else if (row.kind === "add") side = "new";
    else if (row.kind !== "context") continue;
    out[i] = exact((side === "old" ? old : neu).get(i), row.text);
  }
}
