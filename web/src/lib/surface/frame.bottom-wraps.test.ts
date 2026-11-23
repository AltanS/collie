// `idle.frame.bottomWraps` (#838): on a narrow pane Codex wraps the status row that is its box's bottom edge,
// and the row it wraps onto has the edge's shape too. The walk up from that lower row met the real edge
// where the prompt row should be, so no box was found, every dialog reader answered null, and the phone
// showed the unread-dialog card over a pane that was only idle or working.
//
// The four `*-status-wrap--w56` and `--w39` fixtures are CONSTRUCTED, not captured: no capture of a
// wrapped Codex status row exists yet (it needs a Codex login at a narrow width). Each is a committed
// Codex capture (0.166 on herdr-core, 0.167 on Herdr) with its status row wrapped the way the report of
// #838 showed it: greedily, broken after a hyphen inside the path, the next row indented two columns with
// the rest of the path and the segments after it. Transcript rows wider than the new width wrap the same
// way. fixtures/panes/README.md names each one and its source.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { asJsonObject, parseJsonObject, type JsonObject } from "../json";
import { fixtureRows, loadLabels, PANES_DIR, readScreen, rowsOf, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { findInputFrame, rowText, type IdleProfile } from "./frame";
import { loadProfiles, MAX_BOTTOM_WRAPS, parseProfile, ProfileError, requireProfile } from "./profile";
import { isFree } from "./surface";

const CODEX = requireProfile("codex").idle;
/** The Codex profile as it was before #838: the same in every field but `bottomWraps`. */
const UNWRAPPED: IdleProfile = (() => {
  const { bottomWraps: _wraps, ...frame } = CODEX.frame;
  void _wraps;
  return { ...CODEX, frame };
})();

const WRAPPED = {
  idle: "codex--v0166-core-idle-status-wrap--w56.txt",
  draft: "codex--v0166-core-draft-status-wrap--w56.txt",
  working: "codex--v0166-core-working-status-wrap--w56.txt",
  styled: "codex--v0167-working-status-wrap--w39.txt",
} as const;
const CONSTRUCTED: ReadonlySet<string> = new Set(Object.values(WRAPPED));

const lines = (name: string): string[] => readFileSync(join(PANES_DIR, name), "utf8").split("\n");
const read = (raw: readonly string[], idle: IdleProfile = CODEX) => readScreen(rowsOf(raw.join("\n")), "codex", idle);
const frameOf = (raw: readonly string[], idle: IdleProfile = CODEX) => findInputFrame(rowsOf(raw.join("\n")), idle);
/** The index of the last row whose plain text starts with `start`. */
const rowAt = (raw: readonly string[], start: string): number => {
  // eslint-disable-next-line no-control-regex
  const at = raw.findLastIndex((row) => row.replace(/\u001b\[[0-9;]*m/gu, "").startsWith(start));
  if (at < 0) throw new Error(`no row starts with ${start}`);
  return at;
};

describe("a status row that wrapped under the Codex box (#838)", () => {
  it("is set in the Codex profile only, to one row", () => {
    const setting = [...loadProfiles().values()].filter((profile) => profile.idle.frame.bottomWraps !== undefined).map((profile) => [profile.id, profile.idle.frame.bottomWraps]);
    expect(setting).toEqual([["codex", 1]]);
  });

  it("without the field no box is found on any of the four screens: the cause of #838", () => {
    for (const name of Object.values(WRAPPED)) {
      expect(findInputFrame(fixtureRows(name), UNWRAPPED), name).toBeNull();
      expect(isFree(readScreen(fixtureRows(name), "codex", UNWRAPPED).surface), name).toBe(false);
    }
  });

  it("the idle screen reads as the empty box, the wrapped rows and the hint row as status rows", () => {
    const frame = findInputFrame(fixtureRows(WRAPPED.idle), CODEX);
    const raw = lines(WRAPPED.idle);
    expect(frame).toMatchObject({ bottom: rowAt(raw, "  GPT-6.1-Sol low"), placeholder: true, interior: { text: "Ask Codex to do anything" } });
    expect(frame?.volatile.status).toEqual({ first: rowAt(raw, "  lab/codex-lab"), last: rowAt(raw, "  ← for agents") });
    expect(frame?.bottomWrap).toEqual({ first: rowAt(raw, "  lab/codex-lab"), last: rowAt(raw, "  lab/codex-lab") });
    expect(readScreen(fixtureRows(WRAPPED.idle), "codex", CODEX).surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(readScreen(fixtureRows(WRAPPED.idle), "codex", CODEX).surface)).toBe(true);
  });

  it("reads the same Surface as the same pane at 120 columns, where the status row is one row", () => {
    const pairs = [
      [WRAPPED.idle, "codex--v0166-core-idle--w120.txt"],
      [WRAPPED.draft, "codex--v0166-core-draft--w120.txt"],
      [WRAPPED.working, "codex--v0166-core-working--w120.txt"],
      [WRAPPED.styled, "codex--v0167-working--w120.txt"],
    ] as const;
    for (const [wrapped, wide] of pairs) {
      const narrow = readScreen(fixtureRows(wrapped), "codex", CODEX);
      const full = readScreen(fixtureRows(wide), "codex", CODEX);
      expect(narrow.surface, wrapped).toEqual(full.surface);
      expect(narrow.frame?.interior.text, wrapped).toBe(full.frame?.interior.text);
      expect(narrow.frame?.placeholder, wrapped).toBe(full.frame?.placeholder);
    }
  });

  it("a draft in the box is read as the draft alone: no status words join it", () => {
    const drafted = readScreen(fixtureRows(WRAPPED.draft), "codex", CODEX);
    expect(drafted.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(drafted.frame?.interior.text).toBe("collie core draft probe");
    expect(drafted.frame?.volatile.status).toEqual({ first: drafted.frame!.bottom + 1, last: drafted.frame!.bottom + 1 });
  });

  it("a working pane reads as a running turn over the empty box, on the plain and on the styled read", () => {
    for (const name of [WRAPPED.working, WRAPPED.styled]) {
      expect(readScreen(fixtureRows(name), "codex", CODEX).surface, name).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    }
  });
});

describe("the wrap rule opens no hole (#838)", () => {
  it("changes the frame on no fixture of the corpus but the four constructed ones, with the Codex profile and its own", () => {
    const changed: string[] = [];
    let walked = 0;
    for (const dir of [PANES_DIR, SURFACE_FIXTURES_DIR]) {
      for (const name of readdirSync(dir).filter((file) => file.endsWith(".txt"))) {
        const rows = fixtureRows(name, dir);
        walked++;
        if (JSON.stringify(findInputFrame(rows, CODEX)) !== JSON.stringify(findInputFrame(rows, UNWRAPPED))) changed.push(name);
      }
    }
    expect(walked).toBeGreaterThan(400);
    expect(changed.toSorted()).toEqual([...CONSTRUCTED].toSorted());
  }, 20_000);

  it("a third row of the edge's shape is past the bound: no box", () => {
    const raw = lines(WRAPPED.idle);
    const at = rowAt(raw, "  GPT-6.1-Sol low");
    const three = [...raw.slice(0, at), "  GPT-6.1-Sol low · /var/home/alice/.cache/collie-", "  lab/codex-lab/project · Run sleep and list files", "  and one more · status row", ...raw.slice(at + 2)];
    expect(frameOf(three)).toBeNull();
    expect(isFree(read(three).surface)).toBe(false);
  });

  it("a status row with room left for the next row's first word is no wrap: an unrelated row of the edge's shape under it finds no box", () => {
    // The 120-column Herdr capture pads its box rows to the screen's width, so the read says how wide a
    // row may be; its status row ends far short of that.
    const raw = lines("codex--v0167-working--w120.txt");
    const at = rowAt(raw, "  GPT-6-Luna");
    const extra = [...raw.slice(0, at + 1), "  unrelated · row", ...raw.slice(at + 1)];
    expect(findInputFrame(rowsOf(raw.join("\n")), CODEX)).not.toBeNull();
    expect(frameOf(extra)).toBeNull();
    expect(isFree(read(extra).surface)).toBe(false);
  });

  it("on a read that does not show its width, a dialog's key row of the edge's shape under a one-row status is read by the cues: never free", () => {
    // A plain herdr-core read and a tmux read pad no row, so the status row is the widest row and the width
    // test passes whatever follows it. The cues read the rows the edge wrapped onto (`Frame.bottomWrap`).
    const keyRows = ["  enter confirm · esc skip", "  ↑/↓ move · enter select · esc cancel", "  Press enter to confirm · esc to cancel"];
    for (const name of ["codex--v0166-core-idle--w120.txt", "codex--v0166-art-empty--w120.txt"]) {
      const raw = lines(name);
      const hint = rowAt(raw, "  ← for agents");
      for (const keyRow of keyRows) {
        for (const tail of [[], [raw[hint]!]]) {
          const screen = [...raw.slice(0, hint), keyRow, ...tail];
          expect(read(screen).surface.modal, `${name}: ${keyRow}`).toBe("unreadable");
          expect(isFree(read(screen).surface), `${name}: ${keyRow}`).toBe(false);
        }
      }
    }
  });

  it("a dialog whose key rows hold ` · ` is no box, also when its upper key row fills the width", () => {
    // The 0.167 hooks review at 80 columns, its key row doubled: the upper copy padded to the widest row
    // so the width test passes, and the frame's own walk must refuse it.
    const raw = lines("codex--v0167-hooks-review--w80.txt");
    const at = rowAt(raw, "  enter confirm · esc skip");
    const width = Math.max(...rowsOf(raw.join("\n")).map((row) => rowText(row).length));
    const upper = `  ↑/↓ move · ${"x".repeat(width - 16)}-`;
    const doubled = [...raw.slice(0, at), upper, ...raw.slice(at)];
    expect(frameOf(doubled)).toBeNull();
    expect(isFree(read(doubled).surface)).toBe(false);
    expect(read(doubled).surface).toEqual(read(doubled, UNWRAPPED).surface);
  });

  it("a dialog drawn under the box after a wrapped status row keeps the screen from free", () => {
    // Over the unwrapped profile and the wrapped one the screen reads the same: never free.
    const raw = lines(WRAPPED.idle);
    const hint = rowAt(raw, "  ← for agents");
    const dialog = [...raw.slice(0, hint), "  enter confirm · esc skip"];
    expect(isFree(read(dialog).surface)).toBe(false);
    const numbered = [...raw.slice(0, hint), "› 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)", "", "  Press enter to confirm or esc to cancel"];
    expect(isFree(read(numbered).surface)).toBe(false);
  });

  it("every Codex dialog fixture reads as it did, never free", () => {
    const dialogs = Object.entries(loadLabels().fixtures).filter(([, label]) => label.harness === "codex" && (label.state === "dialog" || label.state === "screen")).map(([name]) => name);
    expect(dialogs.length).toBeGreaterThan(15);
    for (const name of dialogs) {
      const now = readScreen(fixtureRows(name), "codex", CODEX);
      expect(now.surface, name).toEqual(readScreen(fixtureRows(name), "codex", UNWRAPPED).surface);
      expect(isFree(now.surface), name).toBe(false);
    }
  });
});

describe("idle.frame.bottomWraps in the profile file", () => {
  const PROFILES_DIR = join(import.meta.dirname, "profiles");
  const rawProfile = (id: string, edit: (frame: JsonObject) => void): JsonObject => {
    const raw = parseJsonObject(readFileSync(join(PROFILES_DIR, `${id}.json`), "utf8"));
    if (raw === undefined) throw new Error(`${id}.json is not a JSON object`);
    const frame = asJsonObject(asJsonObject(raw.idle)?.frame);
    if (frame === undefined) throw new Error(`${id}.json has no idle.frame`);
    edit(frame);
    return raw;
  };
  const failurePath = (raw: JsonObject): string => {
    try {
      parseProfile(raw);
    } catch (error) {
      if (error instanceof ProfileError) return error.path;
      throw error;
    }
    throw new Error("the profile parsed");
  };

  it("is absent from the parsed profile when the file leaves it out", () => {
    expect(parseProfile(rawProfile("codex", (frame) => delete frame.bottomWraps)).idle.frame.bottomWraps).toBeUndefined();
  });

  it("refuses zero, a fraction and a count past the bound", () => {
    for (const value of [0, 1.5, MAX_BOTTOM_WRAPS + 1]) expect(failurePath(rawProfile("codex", (frame) => (frame.bottomWraps = value))), String(value)).toBe("idle.frame.bottomWraps");
  });

  it("refuses the field on the interior walk", () => {
    const interior = [...loadProfiles().values()].find((profile) => profile.idle.frame.walk === "interior");
    if (interior === undefined) throw new Error("no profile walks the interior");
    expect(failurePath(rawProfile(interior.id, (frame) => (frame.bottomWraps = 1)))).toBe("idle.frame.bottomWraps");
  });

  it("refuses the field over a blank bottom edge", () => {
    const raw = rawProfile("codex", (frame) => {
      frame.bottom = { pattern: "^$", column: 0, blank: true };
    });
    expect(failurePath(raw)).toBe("idle.frame.bottomWraps");
  });
});
