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
    screen: string,
    field: RegExp,
    private readonly draw: DrawField,
    private readonly after: string,
  ) {
    this.rows = pane(screen).split("\n");
    this.at = this.rows.findIndex((row) => field.test(row.replace(SGR, "")));
    if (this.at < 0) throw new Error(`${screen} has no field row`);
  }

  private render(): string {
    if (this.closed) return this.after;
    return this.rows.map((text, i) => (i === this.at ? this.draw(this.box) : text)).join("\n");
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

function rig(field: SignInPane, harness: string, version: string) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const ring = new RowRing();
  const store = new RequestStore(join(dir, "sends"), now);
  const protocol = new SendProtocol({
    mux: { readGrid: field.readGrid, typeText: field.typeText, pasteText: field.pasteText },
    gate: new KeyGate(field, now),
    store,
    locks: new SessionLocks(),
    ring,
    profile: () => Promise.resolve(profileFor(harness, version, { log: () => undefined })),
    generation: () => "gen-1",
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
  return { send, ring, store };
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
      const field = new SignInPane("claude--v2325-login-url--w61.txt", CLAUDE_FIELD, claudeField, pane("claude--v2325-login-bad-code--w61.txt"));
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
    const field = new SignInPane("claude--v2325-login-url--w61.txt", CLAUDE_FIELD, claudeField, pane("claude--v2325-login-bad-code--w61.txt"));
    const { send, store } = rig(field, "claude", "2.1.325");
    const answer = await send(SHORT);
    expect(answer.receipt?.outcome).toBe("sent");
    expect(store.get(answer.id)?.line).toBeUndefined();
    expect(requestFiles()).not.toContain(SHORT);
  });

  test("a text of two lines is refused before any key", async () => {
    const field = new SignInPane("claude--v2325-login-url--w61.txt", CLAUDE_FIELD, claudeField, pane("claude--v2325-login-bad-code--w61.txt"));
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
      const field = new SignInPane("pi--v130-login-headless-url--w61.txt", PI_FIELD, piField, pane("pi--v130-login-bad-code--w61.txt"));
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
    const field = new SignInPane("pi--v130-login-headless-url--w61.txt", PI_FIELD, () => "> something else entirely, not the code", pane("pi--v130-login-bad-code--w61.txt"));
    const { send } = rig(field, "pi", "1.3.0");
    const answer = await send(SHORT, { secret: true });
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(field.submitted).toEqual([]);
  });
});
