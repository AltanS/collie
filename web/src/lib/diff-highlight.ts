// Syntax colour for the Changes view's diff rows (ADR 0065 rule 7), by sugar-high. This file is the
// part the main bundle carries: which language a path is, and the one dynamic import that fetches
// the rest. Everything else, sugar-high's core, its language modules and the side split, lives in
// `diff-highlight-engine.ts` and loads only when a diff of a known language opens.

import type { TokenType } from "sugar-high/core";

import type { DiffRow } from "@/lib/unified-diff";

export type SyntaxLang =
  | "typescript"
  | "javascript"
  | "json"
  | "css"
  | "html"
  | "markdown"
  | "python"
  | "go"
  | "rust"
  | "shell"
  | "yaml"
  | "toml"
  | "c"
  | "cpp"
  | "csharp"
  | "java"
  | "kotlin"
  | "lua"
  | "php"
  | "ruby"
  | "sql"
  | "swift"
  | "zig"
  | "dockerfile"
  | "hcl"
  | "graphql";

export interface SyntaxToken {
  type: TokenType;
  value: string;
}

/** One text in, its lines out, each as tokens. What sugar-high's `parse` gives, reduced. */
export type Tokenizer = (code: string) => readonly (readonly SyntaxToken[])[];

/** Above this many lines a diff is drawn plain: colouring it would cost more than it tells. */
export const HIGHLIGHT_MAX_LINES = 2000;

// Maps, not object literals, so a file named `x.constructor` finds nothing on the prototype.
const BY_EXTENSION = new Map<string, SyntaxLang>([
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["json", "json"],
  ["jsonc", "json"],
  ["json5", "json"],
  ["css", "css"],
  ["scss", "css"],
  ["html", "html"],
  ["htm", "html"],
  ["xml", "html"],
  ["svg", "html"],
  ["md", "markdown"],
  ["mdx", "markdown"],
  ["markdown", "markdown"],
  ["py", "python"],
  ["pyi", "python"],
  ["go", "go"],
  ["rs", "rust"],
  ["sh", "shell"],
  ["bash", "shell"],
  ["zsh", "shell"],
  ["yml", "yaml"],
  ["yaml", "yaml"],
  ["toml", "toml"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["hpp", "cpp"],
  ["hh", "cpp"],
  ["cs", "csharp"],
  ["java", "java"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["lua", "lua"],
  ["php", "php"],
  ["rb", "ruby"],
  ["sql", "sql"],
  ["swift", "swift"],
  ["zig", "zig"],
  ["dockerfile", "dockerfile"],
  ["tf", "hcl"],
  ["tfvars", "hcl"],
  ["hcl", "hcl"],
  ["graphql", "graphql"],
  ["gql", "graphql"],
]);

/** Whole file names that carry no extension, or whose extension says nothing. */
const BY_NAME = new Map<string, SyntaxLang>([
  ["dockerfile", "dockerfile"],
  ["containerfile", "dockerfile"],
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
  [".bashrc", "shell"],
  [".zshrc", "shell"],
  [".profile", "shell"],
]);

/** The sugar-high language for a file path, or null when there is none: that diff stays plain. */
export function languageForPath(path: string): SyntaxLang | null {
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  const byName = BY_NAME.get(name);
  if (byName) return byName;
  // `Dockerfile.dev` is still a Dockerfile.
  if (name.startsWith("dockerfile.")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION.get(name.slice(dot + 1)) ?? null;
}

/** Tokens per diff row, index for index, or null for a row that stays plain. */
export type RowTokens = (readonly SyntaxToken[] | null)[];

type Engine = typeof import("@/lib/diff-highlight-engine");

/**
 * Each language's colouring, once its tokenizer has loaded. A diff that changes under an open view
 * (the 5 s re-read) is coloured in the same render as its new rows, so no row ever draws plain in
 * between: the plain frame was the flash the operator saw on every beat that changed the file.
 */
const ready = new Map<SyntaxLang, (rows: readonly DiffRow[]) => RowTokens>();

/** Load the engine and the language (each once), then colour the rows. */
export async function highlightDiff(rows: readonly DiffRow[], lang: SyntaxLang): Promise<RowTokens> {
  const engine: Engine = await import("@/lib/diff-highlight-engine");
  const tokenize = await engine.loadTokenizer(lang);
  ready.set(lang, (r) => engine.highlightRows(r, tokenize));
  return engine.highlightRows(rows, tokenize);
}

/** The rows' tokens at once, when `lang` has loaded before; null when only `highlightDiff` can say. */
export function highlightDiffNow(rows: readonly DiffRow[], lang: SyntaxLang): RowTokens | null {
  return ready.get(lang)?.(rows) ?? null;
}
