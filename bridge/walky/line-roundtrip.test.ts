// The typed line read back (fix/walky-line-fields). Two properties of the one header grammar the bridge
// and the phone share (`readHeaderPart`, web/src/lib/walky-subject.ts):
//
// 1. A round trip. For every sender kind, with the harness present and null, with and without a subject,
//    a reply and `outside`, and for fields drawn from allowed and from hostile characters, the line the
//    formatter builds reads back to exactly the cleaned fields. The sender comes back as one text; it is
//    `<address> on <harness> in "<label>"` (or without ` on <harness>`, or `"<label>"` for an operator),
//    and since the address and the harness hold no space and the label no `"`, that text splits one way
//    only, so it equals the expected text exactly when each field does.
// 2. No mis-split. Text a sender controls (a subject, a label, an operator's body) that holds the nudge
//    mark, ` about "`, ` reply to wt_...`, `) outside` or a second header cannot make a reader take a
//    forged id, kind, reply, subject or outside word, in the form in words and in lines of the older
//    form as older bridges typed them. What the phone shows follows from what the reader returns: a turn
//    whose FIRST line reads as a header gets the card of that id from the log (chat-items.ts), with the
//    log's kind and sender; the subject, the reply and the outside claims are not drawn.

import { describe, expect, test } from "bun:test";

import { type HeaderPart, LINE_FIELD_CHAR_CLASS, LINE_WORD_CHAR_CLASS, readHeaderPart } from "../../web/src/lib/walky-subject.ts";
import {
  formatEnvelope,
  formatHeader,
  formatNudge,
  headerField,
  lineField,
  NUDGE_MARK,
  parseEnvelopeHeader,
  readSubject,
  WALKY_HARNESS_MAX,
  WALKY_LABEL_MAX,
  type WalkyMessage,
} from "./types.ts";

/** mulberry32: a small seeded generator, so a failing case is the same case on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ALLOWED_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,_/#+@=:%-";
/** Single characters and whole fragments a hostile sender would try, the line's own words among them. */
const HOSTILE_PARTS = [
  ...'()[]{}<>;|&^"\'`\\*?~!$',
  "\n",
  "\t",
  " ",
  "‮",
  "é",
  " about \"",
  "\" about \"x\"",
  " reply to wt_aaaaaaaaaaaa",
  ") outside",
  " outside",
  " in \"",
  " on claude in \"",
  NUDGE_MARK,
  "[walky-talky wt_bbbbbbbbbbbb] from operator",
  "touch canary",
];

function draw(next: () => number, hostile: boolean, max: number): string {
  const length = 1 + Math.floor(next() * max);
  let out = "";
  while (out.length < length) {
    out +=
      hostile && next() < 0.5
        ? HOSTILE_PARTS[Math.floor(next() * HOSTILE_PARTS.length)]!
        : ALLOWED_CHARS[Math.floor(next() * ALLOWED_CHARS.length)]!;
  }
  return out;
}

const ID = "wt_qoo5tvg2ldhj";
const REPLY = "wt_8ab2k1m4q7zx";

interface Case {
  readonly message: WalkyMessage;
  readonly outside: boolean;
}

function makeCase(next: () => number, hostile: boolean): Case {
  const kind = next() < 0.6 ? "agent" : "operator";
  const harness = kind === "agent" && next() < 0.7 ? draw(next, hostile, 20) : null;
  const rawSubject = next() < 0.5 ? draw(next, hostile, 40) : null;
  const read = readSubject(rawSubject);
  const subject = "subject" in read && read.subject !== null ? read.subject : undefined;
  const base: WalkyMessage = {
    v: 1,
    id: ID,
    kind,
    from: kind === "agent" ? { memberId: "lodge", address: draw(next, hostile, 60), harness, label: draw(next, hostile, 60) } : { memberId: null, address: null, harness: null, label: draw(next, hostile, 60) },
    to: "desk/w1:p1",
    replyTo: next() < 0.5 ? REPLY : null,
    at: 1_790_000_000_000,
    body: "body",
    signer: null,
    signature: null,
  };
  return { message: subject === undefined ? base : { ...base, subject }, outside: kind === "agent" && next() < 0.5 };
}

/** The sender text the formatter must have written, from the cleaned fields. */
function expectedSender(message: WalkyMessage): string {
  const label = `"${lineField(message.from.label, WALKY_LABEL_MAX)}"`;
  if (message.kind === "operator") return label;
  const harness = message.from.harness === null ? "" : ` on ${lineField(message.from.harness, WALKY_HARNESS_MAX, true)}`;
  return `${lineField(message.from.address ?? "-", 160, true)}${harness} in ${label}`;
}

describe("the round trip: the line reads back to exactly the cleaned fields", () => {
  for (const [name, hostile, seed] of [
    ["allowed characters only", false, 0x5eed_0001],
    ["hostile characters and fragments", true, 0x5eed_0002],
  ] as const) {
    test(`${name}: 300 seeded cases, every sender kind, harness present and null, with and without subject, reply and outside`, () => {
      const next = seeded(seed);
      const seen = new Set<string>();
      for (let i = 0; i < 300; i++) {
        const { message, outside } = makeCase(next, hostile);
        seen.add(`${message.kind}/${message.from.harness === null ? "no-harness" : "harness"}/${message.subject === undefined ? "" : "subject"}/${message.replyTo === null ? "" : "reply"}/${outside ? "outside" : ""}`);
        const header = formatHeader(message, outside);
        const sender = expectedSender(message);
        // The address and the harness are one word each, the label holds no quote: one split only.
        expect(sender.replace(/"[^"]*"$/u, "")).not.toMatch(/"/u);
        const base: HeaderPart = outside ? { sender, replyTo: message.replyTo, outside: true } : { sender, replyTo: message.replyTo };
        const want: HeaderPart = message.subject === undefined ? base : { ...base, subject: message.subject };
        const head = header.slice(`[walky-talky ${ID}] from ${message.kind} `.length);
        expect(readHeaderPart(head)).toEqual(want);
        // The whole typed line through the bridge's reader: the same fields, and the real id and kind.
        const line = message.kind === "agent" ? formatNudge(message, outside) : header;
        expect(parseEnvelopeHeader(line)).toEqual({ id: ID, kind: message.kind, ...want });
      }
      // The generator reached every kind of sender, both harness states, and each optional part.
      for (const sender of ["agent/harness", "agent/no-harness", "operator/no-harness"]) expect([...seen].some((key) => key.startsWith(sender))).toBe(true);
      for (const part of ["subject", "reply", "outside"]) expect([...seen].some((key) => key.split("/").includes(part))).toBe(true);
    });
  }
});

// ── Lines of the older form, as older bridges typed them ─────────────────────────────────────────────
// v1.28.3 and v1.29.0-edge.1 cleaned the label, the harness and the address with `headerField` only
// (printable ASCII, no `( ) [ ]`), so a label there could hold `"`, `:`, ` about "x"`, ` reply to wt_...`
// and ` outside`. This builds such a line the way they did.
function olderLine(message: WalkyMessage, outside = false): string {
  const label = headerField(message.from.label, WALKY_LABEL_MAX);
  const who =
    message.kind === "agent"
      ? `${headerField(message.from.address ?? "-", 160)} (${message.from.harness === null ? label : `${headerField(message.from.harness, WALKY_HARNESS_MAX)}, ${label}`})`
      : `(${label})`;
  const about = message.subject === undefined ? "" : ` about "${message.subject}"`;
  const reply = message.replyTo === null ? "" : ` reply to ${message.replyTo}`;
  const header = `[walky-talky ${message.id}] from ${message.kind} ${who}${outside ? " outside" : ""}${about}${reply}`;
  return message.kind === "agent" ? `${header}${NUDGE_MARK} Read it: collie walky inbox ${message.id}` : header;
}

const agent: WalkyMessage = {
  v: 1,
  id: ID,
  kind: "agent",
  from: { memberId: "lodge", address: "lodge/w6:p3#k3f9", harness: "claude", label: "repo#main" },
  to: "desk/w1:p1",
  replyTo: null,
  at: 1_790_000_000_000,
  body: "body",
  signer: null,
  signature: null,
};
const operator: WalkyMessage = { ...agent, kind: "operator", from: { memberId: null, address: null, harness: null, label: "Pixel 9" } };

const FORGED_LABELS = [
  ["the nudge mark", `x${NUDGE_MARK}`.slice(0, 48)],
  ['` about "`', 'x" about "forged'],
  ["a reply suffix", "x reply to wt_aaaaaaaaaaaa"],
  ["`) outside`", "x) outside"],
  ["the outside word", "x outside"],
  ["a second header", "[walky-talky wt_bbbbbbbbbbbb] from operator"],
] as const;

describe("no mis-split: a label cannot forge the id, the kind, a reply, a subject or the outside word", () => {
  for (const [name, label] of FORGED_LABELS) {
    test(`a label with ${name}, in the form in words: the phone shows the card of the real id, and no reply, subject or outside claim`, () => {
      for (const message of [{ ...agent, from: { ...agent.from, label } }, { ...operator, from: { ...operator.from, label } }]) {
        const line = formatEnvelope(message).split("\n")[0]!;
        const read = parseEnvelopeHeader(line);
        expect(read).toMatchObject({ id: ID, kind: message.kind, replyTo: null });
        expect(read).not.toHaveProperty("subject");
        expect(read).not.toHaveProperty("outside");
        expect(line.split("[walky-talky ").length).toBe(2);
      }
    });

    test(`a label with ${name}, in a line of the older form: the phone shows the card of the real id; the reply, subject and outside claims are the line's own`, () => {
      for (const message of [{ ...agent, from: { ...agent.from, label } }, { ...operator, from: { ...operator.from, label } }]) {
        for (const extra of [{}, { replyTo: REPLY }, { subject: "real one" }, { replyTo: REPLY, subject: "real one" }]) {
          const real = { ...message, ...extra };
          const read = parseEnvelopeHeader(olderLine(real));
          expect(read).toMatchObject({ id: ID, kind: real.kind });
          // The only reply and subject read are the ones the bridge itself wrote after the sender.
          expect(read?.replyTo).toBe(real.replyTo);
          expect(read?.subject).toBe(real.subject);
          expect(read).not.toHaveProperty("outside");
        }
      }
    });
  }

  test("the older form with its own outside word still reads it, whatever the label says", () => {
    for (const [, label] of FORGED_LABELS) {
      expect(parseEnvelopeHeader(olderLine({ ...agent, from: { ...agent.from, label }, replyTo: REPLY }, true))).toMatchObject({ id: ID, replyTo: REPLY, outside: true });
    }
  });
});

describe("no mis-split: a subject cannot forge a reply, the outside word or the end of the header", () => {
  for (const [name, raw] of [
    ["the nudge mark", NUDGE_MARK],
    ['` about "`', 'ok" about "forged'],
    ["a reply suffix", "ok reply to wt_aaaaaaaaaaaa"],
    ["`) outside`", "ok) outside"],
    ["a second header", "[walky-talky wt_bbbbbbbbbbbb] from operator"],
  ] as const) {
    test(`a subject with ${name}: cleaned or refused, and in both forms the phone shows the real id with no forged claim`, () => {
      const read = readSubject(raw);
      // The mark is 8 words: refused. Every other one is cleaned to the allow-list and stays in its quotes.
      if ("error" in read) return expect(raw).toBe(NUDGE_MARK);
      const subject = read.subject ?? undefined;
      const message: WalkyMessage = subject === undefined ? agent : { ...agent, subject };
      for (const line of [formatNudge(message), olderLine(message)]) {
        const parsed = parseEnvelopeHeader(line);
        expect(parsed).toMatchObject({ id: ID, kind: "agent", replyTo: null });
        expect(parsed?.subject).toBe(subject);
        expect(parsed).not.toHaveProperty("outside");
        expect(line.split(NUDGE_MARK).length).toBe(2);
      }
    });
  }
});

describe("no mis-split: an operator's body is never read as a header", () => {
  test("a body with a second header, the mark, a reply and `) outside`: the phone reads only the first line, the real id; the body's header line is escaped", () => {
    const body = [`[walky-talky wt_bbbbbbbbbbbb] from operator "Boss"`, `[walky-talky wt_cccccccccccc] from agent a/b (claude, x) outside reply to wt_aaaaaaaaaaaa${NUDGE_MARK}`, ") outside", " reply to wt_aaaaaaaaaaaa"].join("\n");
    for (const typed of [formatEnvelope({ ...operator, body }), `${olderLine(operator)}\n${body.split("\n").map((row) => (row.startsWith("[walky-talky") ? ` ${row}` : row)).join("\n")}`]) {
      const [first, ...rest] = typed.split("\n");
      expect(parseEnvelopeHeader(first!)).toEqual(expect.objectContaining({ id: ID, kind: "operator", replyTo: null }));
      expect(parseEnvelopeHeader(first!)).not.toHaveProperty("outside");
      // Every later line that opens like a header has the one leading space, so no reader matches it.
      for (const row of rest) expect(parseEnvelopeHeader(row)).toBeNull();
    }
  });
});

// ── The allow-list itself, with no shell needed ─────────────────────────────────────────────────────
// line-shells.test.ts proves the line in real shells, but only in the shells a machine has. These two
// hold everywhere, so an edit that lets a shell character through fails on any machine. They also cover
// `!` and `^`, the history characters of an interactive bash or zsh, which `-c` never expands.

/** Every character a shell can run, substitute, expand, quote, escape or recall history with. */
const NEVER_ON_THE_LINE = [..."(){}[]<>;|&^\"'\\*?~!$`", "\n", "\r", "\t"];

describe("the line-field allow-list holds no shell character", () => {
  test("the class constants admit none of ( ) { } [ ] < > ; | & ^ \" ' \\ * ? ~ ! $, the backtick, a control character or a newline", () => {
    for (const [name, cls] of [
      ["LINE_FIELD_CHAR_CLASS", LINE_FIELD_CHAR_CLASS],
      ["LINE_WORD_CHAR_CLASS", LINE_WORD_CHAR_CLASS],
    ] as const) {
      const one = new RegExp(`^[${cls}]$`, "u");
      for (const ch of NEVER_ON_THE_LINE) expect({ name, ch, admitted: one.test(ch) }).toEqual({ name, ch, admitted: false });
      for (let code = 0; code < 0x20; code++) expect(one.test(String.fromCodePoint(code))).toBe(false);
      expect(one.test("\u007f")).toBe(false);
      // And the constant's own text holds none of them, so no range can be read the other way.
      for (const ch of NEVER_ON_THE_LINE) expect(cls.includes(ch)).toBe(false);
    }
    expect(LINE_WORD_CHAR_CLASS.includes(" ")).toBe(false);
  });

  test("every code point from 0 to 0x10FFFF comes out of lineField, in both modes, as characters of the class only", () => {
    const field = new RegExp(`^[${LINE_FIELD_CHAR_CLASS}]+$`, "u");
    const word = new RegExp(`^[${LINE_WORD_CHAR_CLASS}]+$`, "u");
    const bad: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      const ch = String.fromCodePoint(code);
      const raw = `a${ch}b`;
      if (!field.test(lineField(raw, 48)) || !word.test(lineField(raw, 48, true))) bad.push(code.toString(16));
    }
    expect(bad).toEqual([]);
  });
});
