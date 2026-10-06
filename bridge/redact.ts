// ── SECRETS ARE MASKED BEFORE PANE TEXT LEAVES THE MACHINE ──────────────────────────────────────
//
// A MITIGATION, NOT A GUARANTEE. Text a pane shows can hold a secret: an `env` dump, a `cat .env`,
// a curl line with a bearer token, a key an agent echoed back. Every path that carries that text
// toward a phone runs it through this module first: the terminal mirror (`paneReadResponse` in
// server.ts), the journal reader's Chat and History bodies (`journal/text.ts` § redactEntry), and
// every push payload (`push.ts` § Push.send). One pattern list serves all three, so a shape caught
// in one place is caught in all of them.
//
// ── ONLY HIGH-CONFIDENCE SHAPES ──────────────────────────────────────────────
// The list below matches shapes that are secrets by construction: a vendor prefix that exists only
// on keys, a JWT, a PEM private key block, a bearer token, and a value written beside a name that
// says "password", "secret", "token" or "api key". It deliberately MISSES:
//
//   • plain passwords typed or printed on their own (no shape tells "hunter2" from a word),
//   • bare hex and base64 (a git sha, a content hash and a checksum all look like a key),
//   • a key whose vendor prefix is not in the list, and a value split across two `key=` lines.
//
// A pattern for those would mask ordinary text and code on every screen, which makes the mirror
// useless and teaches the operator to switch this off. Known false positives, accepted: a
// `token: <8+ chars>` line of prose or YAML that is not a secret is masked anyway, and a long
// `sk-…` CSS class or slug would be too.
//
// ── THE MASK KEEPS THE LAYOUT ────────────────────────────────────────────────
// A match is replaced character for character by `•`, so a row keeps its width and the mirror's
// columns hold; a PEM block keeps its line count. A vendor-prefixed key and a JWT keep their first
// four characters (`sk-o••••`, `AKIA••••`), which are the vendor's constant prefix and carry no
// entropy, so the operator still sees WHAT was masked. A bearer token and a `key=value` value are
// masked whole. Every pattern matches printable ASCII only, so one character is one column. On the
// mirror a secret the terminal wrapped at the pane's edge is found across the wrap and masked on both
// rows (see `findSpans`).
//
// The audit trail has its own, different redaction (`audit.ts`), and what the operator SENDS
// (replies, keys) is never touched here: this is only about text going out to a phone.
//
// ── COST ─────────────────────────────────────────────────────────────────────
// The mirror is polled every 1.5 s per open pane. Each pattern opens on a literal prefix and has no
// nested quantifier, so a scan is linear in the text; a screen with no match allocates nothing.
// `redact.test.ts` pins a 200 × 200 screen under 20 ms.
//
// The switch is `COLLIE_REDACT` (`[access] redact`), default on (`config.ts`).

/** The one mask character. One column wide, and never matched by any pattern below. */
export const MASK = "•";

/** One pattern family. `group` names the capture to mask when the whole match is not the secret. */
interface Family {
  readonly name: string;
  readonly re: RegExp;
  /** Leading characters of the masked span left readable — the vendor's constant prefix. */
  readonly keep: number;
  /** Mask only this capture group (it must END the match), not the whole match. */
  readonly group?: number;
  /** A value written beside a name: checked against {@link NOT_A_VALUE} before it is masked. */
  readonly named?: true;
}

// The value of a `password=` style pair: printable ASCII minus whitespace, quotes, the backtick and
// the separators that end a value in a URL query, a shell line or a list (`&`, `,`, `;`, `<`, `>`).
const VALUE_CHARS = "[\\x21\\x23-\\x25\\x28-\\x2b\\x2d-\\x3a\\x3d\\x3f-\\x5f\\x61-\\x7e]";

/** Every family, in no order that matters: overlapping matches merge. */
const FAMILIES: readonly Family[] = [
  // OpenAI `sk-…`, `sk-proj-…`, Anthropic `sk-ant-…`, OpenRouter `sk-or-v1-…`. One family, because
  // the generic shape already covers the three prefixed ones; 20 characters after `sk-` keeps a
  // short slug such as `sk-learn` out.
  { name: "api key", re: /\bsk-[A-Za-z0-9_-]{20,}/g, keep: 4 },
  // GitHub personal, OAuth, user-to-server, server-to-server and refresh tokens, and fine-grained PATs.
  { name: "github token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, keep: 4 },
  { name: "github token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g, keep: 4 },
  // Slack bot, user, app and refresh tokens.
  { name: "slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, keep: 4 },
  // AWS access key id: exactly `AKIA` and sixteen uppercase letters or digits.
  { name: "aws key", re: /\bAKIA[0-9A-Z]{16}\b/g, keep: 4 },
  // Google API key: `AIza` and 35 more.
  { name: "google key", re: /\bAIza[0-9A-Za-z_-]{35,}/g, keep: 4 },
  { name: "gitlab token", re: /\bglpat-[0-9A-Za-z_-]{20,}/g, keep: 4 },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36,}/g, keep: 4 },
  // A JWT: three base64url segments, the first a JSON header (`eyJ` is `{"` encoded).
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, keep: 4 },
  // `Authorization: Bearer <token>`, in a header, a curl line or a log. The token is masked whole.
  { name: "bearer token", re: /\b[Bb]earer[ \t]+([A-Za-z0-9._~+/=-]{20,})/g, keep: 0, group: 1 },
  // `password=…`, `DB_PASSWORD: …`, `"api_key": "…"`, `GITHUB_TOKEN=…`. The name may sit inside a
  // longer one (`AWS_SECRET_ACCESS_KEY`), the value must be 8 or more characters, and only the
  // value is masked. `tokens:` and `token_count:` do not match: the name must be followed by its
  // separator, optionally through a closing quote.
  {
    name: "credential",
    re: new RegExp(
      `(?:pass(?:word|wd|phrase)|secret|token|api[_-]?key|access[_-]?key)(?:[_-]?key)?["']?[ \\t]{0,3}[:=][ \\t]{0,3}["']?(${VALUE_CHARS}{8,})`,
      "gi",
    ),
    keep: 0,
    group: 1,
    named: true,
  },
];

/**
 * A `key=value` value that is code or a placeholder, not a secret: `process.env.TOKEN`,
 * `options.secret`, `$TOKEN`, `${API_KEY}`, `%(token)s`, `<your-token>`, `undefined`, and a call or
 * an index on an identifier (`useToken()`, `getSecret(cfg)`, `cfg.keys[0]`), with the closing
 * brackets of an enclosing call allowed after it. Masking these would hide the code an agent is
 * writing and protect nothing. A value with text after its brackets (`abc(1)xyz`) is still masked.
 */
const NOT_A_VALUE =
  /^(?:[$%{(<[]|(?:undefined|required|optional|boolean)$|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[()[\]{}]*$|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\([^()]*\)|\[[^[\]]*\])[)\]}]*$)/;

/** A named value that is itself a vendor-prefixed key keeps its prefix readable, as it would alone. */
const PREFIXED = /^(?:sk-|gh[pousr]_|github_pat_|xox[abprs]-|AKIA|AIza|glpat-|npm_|eyJ)/;

// A PEM private key: the BEGIN line, the body, the END line. Found by hand rather than by one regex,
// because a lazy `[\s\S]*?` to the END line is quadratic on a screen full of BEGIN lines with no END.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** A PEM body line when the END line is off screen: base64, or a `Proc-Type:` style header. */
const PEM_BODY_LINE = /^[A-Za-z0-9+/=:,\- \t]*$/;
/**
 * Everything between BEGIN and END, when it is a key body: base64 lines, headers, and the `\n`
 * escapes of a key quoted inside JSON. Anything else between them is code that happens to spell both
 * markers (a PEM writer, this file), and is left alone.
 */
const PEM_BODY = /^[A-Za-z0-9+/=:,\\\-\s]*$/;
/** A 4096-bit RSA key is about 3.2 KB of body; past this the END line is not this block's. */
const PEM_MAX_BODY = 16_384;

/** A half-open `[start, end)` span of code units to mask. */
type Span = readonly [number, number];

/** Every span to mask in `text`, the vendor families first and the PEM bodies after. */
function scan(text: string): Span[] {
  const spans: Span[] = [];
  for (const family of FAMILIES) {
    family.re.lastIndex = 0;
    for (let m = family.re.exec(text); m !== null; m = family.re.exec(text)) {
      const value = family.group === undefined ? m[0] : (m[family.group] ?? "");
      let keep = family.keep;
      if (family.named === true) {
        if (NOT_A_VALUE.test(value)) continue;
        if (PREFIXED.test(value)) keep = 4;
      }
      const end = m.index + m[0].length;
      const start = end - value.length + keep;
      if (start < end) spans.push([start, end]);
    }
  }
  pemSpans(text, spans);
  return spans;
}

/**
 * Find every span to mask. `wrapped` is a terminal grid: there a row as wide as the widest row ran
 * into the pane's edge, so the line break after it is the terminal's wrap and not the text's own,
 * and a key or a JWT continues on the next row. The patterns then run over the rows joined back at
 * those breaks, and each span is mapped back onto the grid, so the mask covers both halves. A row
 * that merely happens to be the widest joins its neighbour too; the cost is a mask that may run a
 * few characters into the next row when the widest row ends in a secret, never a missed one.
 */
function findSpans(text: string, wrapped: boolean): Span[] {
  if (!wrapped) return scan(text);
  const logical = unwrap(text);
  if (logical === null) return scan(text);
  const { joined, at } = logical;
  return scan(joined).map(([start, end]): Span => [at[start]!, at[end - 1]! + 1]);
}

/**
 * The grid's text with each wrap removed, plus where every character of it sits in the grid; or null
 * when no row reaches the edge with a row after it, which is the ordinary case and costs one pass.
 */
function unwrap(text: string): { joined: string; at: Int32Array } | null {
  const width = widestRow(text);
  if (width === 0) return null;
  const at = new Int32Array(text.length);
  let joined = "";
  let size = 0;
  let rowStart = 0;
  let any = false;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", rowStart)) {
    const rowEnd = i > rowStart && text[i - 1] === "\r" ? i - 1 : i;
    const keepBreak = rowEnd - rowStart < width;
    const upTo = keepBreak ? i + 1 : rowEnd;
    if (!keepBreak) any = true;
    joined += text.slice(rowStart, upTo);
    for (let k = rowStart; k < upTo; k++) at[size++] = k;
    rowStart = i + 1;
  }
  if (!any) return null;
  joined += text.slice(rowStart);
  for (let k = rowStart; k < text.length; k++) at[size++] = k;
  return { joined, at };
}

/** The longest row's length: the grid's width, as far as the text can tell. */
function widestRow(text: string): number {
  let widest = 0;
  let start = 0;
  for (let i = text.indexOf("\n"); ; i = text.indexOf("\n", start)) {
    const end = i === -1 ? text.length : i;
    const row = end > start && text[end - 1] === "\r" ? end - start - 1 : end - start;
    if (row > widest) widest = row;
    if (i === -1) return widest;
    start = i + 1;
  }
}

/** Append the body of every PEM private key block: every line between BEGIN and END. */
function pemSpans(text: string, spans: Span[]): void {
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(text); m !== null; m = PEM_BEGIN.exec(text)) {
    const bodyStart = m.index + m[0].length;
    PEM_END.lastIndex = bodyStart;
    const end = PEM_END.exec(text);
    if (end !== null && end.index - bodyStart <= PEM_MAX_BODY && PEM_BODY.test(text.slice(bodyStart, end.index))) {
      spans.push([bodyStart, end.index]);
      PEM_BEGIN.lastIndex = end.index + end[0].length;
      continue;
    }
    // No END on screen: the block runs off the bottom. Mask the lines that still look like a body.
    let cursor = text.indexOf("\n", bodyStart);
    let last = bodyStart;
    while (cursor !== -1) {
      const lineEnd = text.indexOf("\n", cursor + 1);
      const line = text.slice(cursor + 1, lineEnd === -1 ? text.length : lineEnd);
      if (line.trim() === "" || !PEM_BODY_LINE.test(line)) break;
      last = lineEnd === -1 ? text.length : lineEnd;
      cursor = lineEnd;
    }
    if (last > bodyStart) spans.push([bodyStart, last]);
  }
}

/** Replace every code unit inside a span with {@link MASK}, line breaks excepted. Same length. */
function applySpans(text: string, spans: readonly Span[]): string {
  const masked = new Uint8Array(text.length);
  for (const [start, end] of spans) masked.fill(1, start, end);
  let out = "";
  let runStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (masked[i] === 0) continue;
    const ch = text[i];
    if (ch === "\n" || ch === "\r") continue;
    out += text.slice(runStart, i) + MASK;
    runStart = i + 1;
  }
  return out + text.slice(runStart);
}

/**
 * Mask every high-confidence secret in plain text. Same length as the input, line for line, so it
 * is safe for a column layout and for a block whose line count the reader depends on.
 */
export function redactText(text: string): string {
  if (text === "") return text;
  const spans = findSpans(text, false);
  return spans.length === 0 ? text : applySpans(text, spans);
}

/**
 * Mask secrets across a row of styled segments: the text pieces of one screen, in order, with the
 * escapes taken out. The patterns run over the JOINED text, so a secret split by a colour change is
 * still found; the mask is then cut back at the original boundaries, so the segment count and every
 * segment's length are unchanged. `wrapped` follows a token across a full-width row's wrap, which is
 * what a terminal grid has and a log does not.
 */
export function redactSegments(segments: readonly string[], wrapped = false): string[] {
  const joined = segments.join("");
  const spans = joined === "" ? [] : findSpans(joined, wrapped);
  if (spans.length === 0) return [...segments];
  const masked = applySpans(joined, spans);
  const out: string[] = [];
  let at = 0;
  for (const segment of segments) {
    out.push(masked.slice(at, at + segment.length));
    at += segment.length;
  }
  return out;
}

// The escapes a pane read carries, as the phone's own tokenizer reads them (`web/src/lib/ansi.ts`):
// CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), and any other two-character escape.
// ESC is spliced in from its code point for the reason `journal/text.ts` gives.
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const ESCAPE_RE = new RegExp(
  `${ESC}\\[[<=>?]*[0-9;:]*[ -/]*[@-~]?|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[\\s\\S]?`,
  "g",
);

/**
 * {@link redactSegments} over a terminal read that still carries its escapes: the mirror's `text`.
 *
 * Strip-aware. The patterns see the text a person sees, never an escape, and every escape comes back
 * byte for byte where it was, so colours and the client's parse are untouched. An OSC string (a
 * title, a hyperlink target) is not shown by the phone but does travel, so its payload is masked on
 * its own with {@link redactText}.
 */
export function redactAnsi(text: string): string {
  if (text === "") return text;
  if (!text.includes(ESC)) return redactSegments([text], true)[0]!;
  const pieces: string[] = [];
  const escapes: string[] = [];
  let at = 0;
  ESCAPE_RE.lastIndex = 0;
  for (let m = ESCAPE_RE.exec(text); m !== null; m = ESCAPE_RE.exec(text)) {
    pieces.push(text.slice(at, m.index));
    escapes.push(m[0].startsWith(`${ESC}]`) ? redactText(m[0]) : m[0]);
    at = m.index + m[0].length;
  }
  pieces.push(text.slice(at));
  const masked = redactSegments(pieces, true);
  let out = masked[0]!;
  for (let i = 0; i < escapes.length; i++) out += escapes[i]! + masked[i + 1]!;
  return out;
}
