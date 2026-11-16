// The Send Protocol at a sign-in field (`idle.frame.secret`): the field `/login` opens for the code or
// the redirect address a login page shows. Claude Code 2.1.325 draws what is typed as `*` but the last
// six characters, and a text longer than the row as `*` cut with `…`; pi 1.3.0 shows it as typed and
// scrolls a long one, so only its end is on screen. Lab captures of 2026-11-15 (`claude--v2325-login-*`,
// `pi--v130-login-*`), the field row redrawn from what the rig typed.
//
// What must hold: the text is typed, checked in the field's own drawn form and submitted; the request
// file keeps no line of it; the memory ring keeps no row of the field; a text of two lines is refused.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { HoldStore } from "./holds.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;:]*m`, "gu");
const pane = (name: string): string => readFileSync(join(PANES, name), "utf8").replace(/\r/gu, "");

/** A code shaped like the one Claude's login page shows: longer than a 61-column row. */
const CODE = "FAKEcodeAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij-_FAKE#FAKEstateAbCdEfGhIjKlMnOpQrStUvWxYz012345";
const SHORT = "FAKECODE123#FAKESTATE";

/** How one harness draws its sign-in field row for the text typed so far. */
type DrawField = (typed: string) => string;

/** Claude Code 2.1.325 at 61 columns: `*` but the last six, or a row of `*` cut with `…` when it does not fit. */
const claudeField: DrawField = (typed) => {
  const lead = "  Paste code here if prompted >";
  if (typed === "") return lead;
  const chars = [...typed];
  const clear = Math.min(6, chars.length);
  const masked = "*".repeat(chars.length - clear) + chars.slice(chars.length - clear).join("");
  return lead.length + 1 + masked.length <= 61 ? `${lead} ${masked}` : `${lead}${"*".repeat(27)}…`;
};

/** pi 1.3.0 at 61 columns: the text as typed after `> `, scrolled to its last 58 characters. */
const piField: DrawField = (typed) => `> ${[...typed].slice(-58).join("")}`;

/** A pane that shows a sign-in screen, redraws its field row from what was typed, and shows `after` once Enter submits. */
class SignInPane {
  box = "";
  submitted: string[] = [];
  keysSeen: string[] = [];
  private reads = 0;
  private closed = false;
  private readonly rows: string[];
  private readonly at: number;

  constructor(
    screen: { readonly fixture: string } | { readonly rows: readonly string[] },
    field: RegExp,
    private readonly draw: DrawField,
    private readonly after: string,
  ) {
    this.rows = "fixture" in screen ? pane(screen.fixture).split("\n") : [...screen.rows];
    this.at = this.rows.findIndex((row) => field.test(row.replace(SGR, "")));
    if (this.at < 0) throw new Error(`${screen} has no field row`);
  }

  private render(): string {
    if (this.closed) return this.after;
    // A field that wraps (Claude Code's first-run field) draws over the rows under it.
    const drawn = this.draw(this.box).split("\n");
    return this.rows.map((text, i) => (i >= this.at && i < this.at + drawn.length ? drawn[i - this.at]! : text)).join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.reads }));
  };

  private take(text: string): void {
    if (!this.closed) this.box += text;
  }

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.take(text);
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.take(text);
    return Promise.resolve(muxAck());
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (this.closed) continue;
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "Enter") {
        this.submitted.push(this.box);
        this.box = "";
        this.closed = true;
      }
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-sign-in-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

function rig(field: SignInPane, harness: string, version: string, withHolds = false) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const holds = withHolds ? new HoldStore(join(dir, "held"), now) : undefined;
  const ring = new RowRing();
  const store = new RequestStore(join(dir, "sends"), now);
  // What the shell-line record (sent.ts) would be handed: a sign-in code never reaches it.
  const blind: string[] = [];
  const protocol = new SendProtocol({
    mux: { readGrid: field.readGrid, typeText: field.typeText, pasteText: field.pasteText },
    gate: new KeyGate(field, now),
    store,
    locks: new SessionLocks(),
    ring,
    holds,
    profile: () => Promise.resolve(profileFor(harness, version, { log: () => undefined })),
    generation: () => "gen-1",
    blindSent: (sent) => blind.push(sent.text),
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer & { id: string }> => {
    const id = `req-signin-${String(++ids).padStart(6, "0")}`;
    return protocol.handle({ id, text, mode: "send", fromPhone: true, ...over }, { session: "main", paneId: "%1", harness }).then((answer) => ({ ...answer, id }));
  };
  return { send, ring, store, holds, blind };
}

/** Every request file's bytes, together. */
function requestFiles(): string {
  const sends = join(dir, "sends");
  return readdirSync(sends)
    .map((name) => readFileSync(join(sends, name), "utf8"))
    .join("\n");
}

const CLAUDE_FIELD = /^ {2}Paste code here if prompted >/u;
const PI_FIELD = /^> ?/u;

describe("Claude Code's sign-in field hides the code: the send is checked by its mask", () => {
  for (const [name, code] of [
    ["a code that fits the row, checked by its length and its clear tail", SHORT],
    ["a code longer than the row, checked as a full row of the mask cut with …", CODE],
  ] as const) {
    test(name, async () => {
      const field = new SignInPane({ fixture: "claude--v2325-login-url--w61.txt" }, CLAUDE_FIELD, claudeField, pane("claude--v2325-login-bad-code--w61.txt"));
      const { send, ring, store } = rig(field, "claude", "2.1.325");
      const view = await send("", { mode: "prepare" });
      expect(view.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty", field: "secret" });
      const answer = await send(code, { secret: true });
      expect(answer.receipt?.outcome).toBe("sent");
      expect(answer.receipt?.keys.at(-1)).toBe("Enter");
      expect(field.submitted).toEqual([code]);
      // No record keeps the code: no line in the request file, no field row in the memory ring.
      expect(store.get(answer.id)?.line).toBeUndefined();
      expect(requestFiles()).not.toContain(code);
      expect(ring.of(answer.id).some((entry) => entry.rows.some((row) => row.includes(code.slice(-6))))).toBe(false);
    });
  }

  test("a send that does not name the field loses its line at S0 all the same", async () => {
    const field = new SignInPane({ fixture: "claude--v2325-login-url--w61.txt" }, CLAUDE_FIELD, claudeField, pane("claude--v2325-login-bad-code--w61.txt"));
    const { send, store } = rig(field, "claude", "2.1.325");
    const answer = await send(SHORT);
    expect(answer.receipt?.outcome).toBe("sent");
    expect(store.get(answer.id)?.line).toBeUndefined();
    expect(requestFiles()).not.toContain(SHORT);
  });

  test("a code meant for the field is never held: a held text waits on disk in plain form", async () => {
    // The field closed under the send: the method list is up, a modal, which holds an ordinary send.
    const field = new SignInPane({ fixture: "claude--v2325-login-methods--w61.txt" }, /^ {2}Esc to cancel$/u, () => "  Esc to cancel", "");
    const { send, holds } = rig(field, "claude", "2.1.325", true);
    const answer = await send(SHORT, { secret: true });
    expect(answer.receipt?.outcome).toBe("refused");
    expect(holds?.waiting("main", "%1")).toHaveLength(0);
    expect(readdirSync(dir).includes("held") ? readdirSync(join(dir, "held")).map((name) => readFileSync(join(dir, "held", name), "utf8")).join("") : "").not.toContain(SHORT);
    expect(field.submitted).toEqual([]);
  });

  test("a text of two lines is refused before any key", async () => {
    const field = new SignInPane({ fixture: "claude--v2325-login-url--w61.txt" }, CLAUDE_FIELD, claudeField, pane("claude--v2325-login-bad-code--w61.txt"));
    const { send } = rig(field, "claude", "2.1.325");
    const answer = await send(`${SHORT}\nmore`, { secret: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "multiline", keys: [] });
    expect(field.keysSeen).toEqual([]);
  });
});

describe("pi's sign-in field shows the code and scrolls a long one: the send is checked by its end", () => {
  for (const [name, code] of [
    ["a code that fits the row", SHORT],
    ["a redirect address longer than the row, checked by the end the field scrolled to", `http://localhost:53692/callback?code=${CODE}&state=FAKEstate`],
  ] as const) {
    test(name, async () => {
      const field = new SignInPane({ fixture: "pi--v130-login-headless-url--w61.txt" }, PI_FIELD, piField, pane("pi--v130-login-bad-code--w61.txt"));
      const { send, ring, store } = rig(field, "pi", "1.3.0");
      const answer = await send(code, { secret: true });
      expect(answer.receipt?.outcome).toBe("sent");
      expect(field.submitted).toEqual([code]);
      expect(store.get(answer.id)?.line).toBeUndefined();
      expect(requestFiles()).not.toContain(code);
      expect(ring.of(answer.id).some((entry) => entry.rows.some((row) => row.includes("FAKE")))).toBe(false);
    });
  }

  test("a field that shows another text than the one typed is no evidence: the code is not submitted", async () => {
    const field = new SignInPane({ fixture: "pi--v130-login-headless-url--w61.txt" }, PI_FIELD, () => "> something else entirely, not the code", pane("pi--v130-login-bad-code--w61.txt"));
    const { send } = rig(field, "pi", "1.3.0");
    const answer = await send(SHORT, { secret: true });
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(field.submitted).toEqual([]);
  });
});

/**
 * Claude Code 2.1.325's FIRST-RUN field at `width` columns: the text wraps under the label, 31 columns
 * in, never cut, and only the last row shows clear characters, at most six (lab, 2026-11-15).
 */
const firstRunField =
  (width: number): DrawField =>
  (typed) => {
    const lead = " Paste code here if prompted >";
    if (typed === "") return lead;
    const chars = [...typed];
    const room = width - lead.length - 2;
    const rows: string[][] = [];
    for (let at = 0; at < chars.length; at += room) rows.push(chars.slice(at, at + room));
    const lastRow = rows[rows.length - 1]!;
    const clear = Math.min(6, lastRow.length);
    const drawn = rows.map((row, r) => row.map((char, i) => (r === rows.length - 1 && i >= row.length - clear ? char : "*")).join(""));
    return drawn.map((row, i) => (i === 0 ? `${lead} ${row}` : `${" ".repeat(lead.length + 1)}${row}`)).join("\n");
  };

const FIRST_RUN_FIELD = /^ Paste code here if prompted >/u;

/** The first-run screen with the field's label as it is drawn, and a bad code's answer under it. */
function firstRunPane(screen: { readonly fixture: string } | { readonly rows: readonly string[] }, width: number): SignInPane {
  return new SignInPane(screen, FIRST_RUN_FIELD, firstRunField(width), pane("claude--v2325-login-bad-code--w61.txt"));
}

/** Every held file's bytes, together. */
function heldFiles(): string {
  const held = join(dir, "held");
  return readdirSync(dir).includes("held") ? readdirSync(held).map((name) => readFileSync(join(held, name), "utf8")).join("") : "";
}

describe("Claude Code's first-run sign-in field (an empty config folder) takes the same secret send", () => {
  for (const [fixture, width] of [
    ["claude--v2325-first-run-url--w61.txt", 61],
    ["claude--v2325-first-run-url--w40.txt", 40],
  ] as const) {
    for (const [what, code] of [
      ["a short code", SHORT],
      ["a code that wraps under the label", CODE],
    ] as const) {
      test(`${fixture}: ${what}, checked by its wrapped mask`, async () => {
        const field = firstRunPane({ fixture }, width);
        const { send, ring, store, holds, blind } = rig(field, "claude", "2.1.325", true);
        const view = await send("", { mode: "prepare" });
        expect(view.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty", field: "secret" });
        const answer = await send(code, { secret: true });
        expect(answer.receipt?.outcome).toBe("sent");
        expect(field.submitted).toEqual([code]);
        expect(store.get(answer.id)?.line).toBeUndefined();
        expect(requestFiles()).not.toContain(code);
        expect(ring.of(answer.id).some((entry) => entry.rows.some((row) => row.includes(code.slice(-5))))).toBe(false);
        expect(holds?.waiting("main", "%1")).toHaveLength(0);
        expect(blind).toEqual([]);
      });
    }
  }

  test("a send from a phone that does not name the field loses its line at S0 all the same", async () => {
    const field = firstRunPane({ fixture: "claude--v2325-first-run-url--w61.txt" }, 61);
    const { send, store } = rig(field, "claude", "2.1.325");
    const answer = await send(CODE);
    expect(answer.receipt?.outcome).toBe("sent");
    expect(store.get(answer.id)?.line).toBeUndefined();
    expect(requestFiles()).not.toContain(CODE);
  });
});

describe("fail closed: a sign-in prompt no layout reads keeps no line and is never held", () => {
  // The first-run field with the rows over it scrolled off the pane: no layout reads the field (its
  // anchor is gone), so no box is found, but the profile's `signInRows` still names it.
  const rows = pane("claude--v2325-first-run-url--w61.txt").split("\n");
  const at = rows.findIndex((row) => FIRST_RUN_FIELD.test(row.replace(SGR, "")));
  const scrolled = rows.slice(at - 4);

  test("the Surface names the field; a send is refused unread, with no line on disk and nothing held", async () => {
    const field = firstRunPane({ rows: scrolled }, 61);
    const { send, store, holds, blind } = rig(field, "claude", "2.1.325", true);
    const view = await send("", { mode: "prepare" });
    expect(view.surface).toMatchObject({ composer: "unknown", field: "secret" });
    const answer = await send(SHORT);
    expect(answer.receipt?.outcome).toBe("refused");
    expect(answer.receipt?.keys).toEqual([]);
    expect(store.get(answer.id)?.line).toBeUndefined();
    expect(requestFiles()).not.toContain(SHORT);
    expect(holds?.waiting("main", "%1")).toHaveLength(0);
    expect(heldFiles()).not.toContain(SHORT);
    expect(field.submitted).toEqual([]);
    expect(blind).toEqual([]);
  });

  test("the person's confirm after it (Type here) keeps no line either", async () => {
    const field = firstRunPane({ rows: scrolled }, 61);
    const { send, store, holds, blind } = rig(field, "claude", "2.1.325", true);
    const first = await send(SHORT);
    const rowsHash = first.receipt?.outcome === "refused" ? first.rowsHash : undefined;
    expect(rowsHash).toBeDefined();
    const answer = await send(SHORT, { rowsHash });
    expect(store.get(answer.id)?.line).toBeUndefined();
    expect(requestFiles()).not.toContain(SHORT);
    expect(holds?.waiting("main", "%1")).toHaveLength(0);
    expect(blind).toEqual([]);
  });
});

describe("a sign-in code never joins a pane's hold queue", () => {
  // A pane that holds a message (a turn ran when it was sent) and now shows the sign-in field: a new
  // message joins the end of the queue without a read, and a held text waits on disk in plain form.
  // A send the phone names a sign-in code goes now instead, and keeps no copy anywhere.
  test("a named code runs at once on a pane with a held message, and nothing of it is held", async () => {
    const field = firstRunPane({ fixture: "claude--v2325-first-run-url--w61.txt" }, 61);
    const { send, store, holds } = rig(field, "claude", "2.1.325", true);
    holds!.add({ id: "req-held-000001", session: "main", paneId: "%1", harness: "claude", mode: "send", text: "an earlier message", revision: 0, command: false, cause: "turn_running" });
    const answer = await send(CODE, { secret: true });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(field.submitted).toEqual([CODE]);
    expect(holds!.waiting("main", "%1").map((entry) => entry.id)).toEqual(["req-held-000001"]);
    expect(heldFiles()).not.toContain(CODE);
    expect(store.get(answer.id)?.line).toBeUndefined();
    expect(requestFiles()).not.toContain(CODE);
  });

  test("an ordinary message on the same pane still joins the queue", async () => {
    const field = firstRunPane({ fixture: "claude--v2325-first-run-url--w61.txt" }, 61);
    const { send, holds } = rig(field, "claude", "2.1.325", true);
    holds!.add({ id: "req-held-000002", session: "main", paneId: "%1", harness: "claude", mode: "send", text: "an earlier message", revision: 0, command: false, cause: "turn_running" });
    const answer = await send("a later message");
    expect(answer.receipt?.outcome).toBe("held");
    expect(holds!.waiting("main", "%1")).toHaveLength(2);
  });
});

describe("the first-run theme step is a question the phone answers with keys: a send types nothing", () => {
  // The theme list lifts as a choice card (web/src/lib/harness/claude/first-run-theme.ts) and takes no
  // text; the rig keeps every typed character in `box`. Like the sign-in method list, the modal holds
  // an ordinary send and refuses a sign-in code.
  const START = /^Let's get started\.$/u;
  for (const width of [61, 40]) {
    const fixture = `claude--v2325-first-run-theme--w${String(width)}.txt`;
    const startRow = pane(fixture).split("\n").find((row) => START.test(row.replace(SGR, "").trim()))!;
    const themePane = (): SignInPane => new SignInPane({ fixture }, /^ *Let's get started\.$/u, () => startRow, "");

    test(`w${String(width)}: the Surface reads the seven rows as a question, and a send is held, nothing typed`, async () => {
      const field = themePane();
      const { send, holds, blind } = rig(field, "claude", "2.1.325", true);
      const view = await send("", { mode: "prepare" });
      expect(view.surface).toMatchObject({ modal: { ask: { kind: "question", channel: "keys" } } });
      expect(view.offers).toEqual(["keys"]);
      const answer = await send("hello");
      expect(answer.receipt?.outcome).toBe("held");
      expect(answer.receipt?.keys).toEqual([]);
      expect(field.box).toBe("");
      expect(field.keysSeen).toEqual([]);
      expect(field.submitted).toEqual([]);
      expect(holds?.waiting("main", "%1")).toHaveLength(1);
      expect(blind).toEqual([]);
    });

    test(`w${String(width)}: a sign-in code sent here is refused, never typed and never held`, async () => {
      const field = themePane();
      const { send, holds } = rig(field, "claude", "2.1.325", true);
      const answer = await send(SHORT, { secret: true });
      expect(answer.receipt?.outcome).toBe("refused");
      expect(answer.receipt?.keys).toEqual([]);
      expect(field.box).toBe("");
      expect(field.keysSeen).toEqual([]);
      expect(holds?.waiting("main", "%1")).toHaveLength(0);
      expect(heldFiles()).not.toContain(SHORT);
    });
  }
});
