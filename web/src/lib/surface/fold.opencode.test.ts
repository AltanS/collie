import { describe, expect, it } from "vitest";

import { fixtureRows, idleFor } from "../../test/surface-corpus";
import { labelOf, own } from "../../test/surface-fold";
import { edgeRunListRow } from "./command-list";
import { commandListAt, ownCommandList } from "./cues";
import { findInputFrame, rowText, type FrameRow } from "./frame";
import { asJsonObject, type JsonObject } from "../json";
import { parseProfile, ProfileError } from "./profile";
import { PROFILE_FILES } from "./profiles/index";
import { isFree } from "./surface";

// #749 (lab 2026-11-09, opencode 2.2.6 and 1.19.5): a text that starts with `/` opens opencode's command
// list in the box's own edge run, right over the bare top edge row, each entry closed by a `┃` of its own.
// The walk went up through the list and found no top edge, so no box. The profile now names the list
// (`sides: ["above"]`, `inEdgeRun`) and its pointer, the entry on a fill of its own (`pointerFill`). The
// typed command's own list reads as composing; a list that points elsewhere, or whose pointer is not
// read, holds Enter like a dialog over the box.
const IDLE = idleFor("opencode")!;
const LIST = IDLE.volatile.below.commandList;

const at = (name: string) => {
  const rows = fixtureRows(name);
  const frame = findInputFrame(rows, IDLE)!;
  const texts = rows.map(rowText);
  return { rows, frame, texts, list: commandListAt(texts, frame, LIST, rows) };
};

/** The rows with every run's colours taken off: a read without SGR. */
const unstyled = (rows: readonly FrameRow[]): FrameRow[] => rows.map((row) => ({ segments: [{ text: rowText(row) }] }));

describe("the typed command's own list over the box (#749, A)", () => {
  it.each(["oc--v226-slash-compact.txt", "oc--v226-narrow--slash-compact.txt"])("%s: /compact typed, the fill on /compact, reads as composing", (name) => {
    const read = own(name);
    expect(read.frame?.interior.text).toBe("/compact");
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(labelOf(name).state).toBe("popup");
    const { rows, frame, texts, list } = at(name);
    expect(list).toMatchObject({ pointed: "/compact", side: "above", entries: ["/compact", "/review"] });
    expect(list?.last).toBe(frame.top - 1);
    expect(ownCommandList(texts, frame, IDLE, rows)).not.toBeNull();
  });

  it("oc--v226-herdr--slash-models.txt: a Herdr read, the app's own fill beside the box, /models pointed", () => {
    const read = own("oc--v226-herdr--slash-models.txt");
    expect(read.surface).toMatchObject({ modal: "none", composer: "draft" });
    expect(at("oc--v226-herdr--slash-models.txt").list).toMatchObject({ pointed: "/models", entries: ["/models"] });
  });

  it("the list stands over the same top edge the idle box has: the box did not move", () => {
    expect(at("oc--v226-slash-compact.txt").frame.top).toBe(at("oc--v226-session-idle.txt").frame.top);
    expect(at("oc--v226-slash-comp.txt").frame.top).toBe(at("oc--v226-fresh-idle.txt").frame.top);
  });

  it("another text in the box under the same list is not its own: /compacx under the fill on /compact", () => {
    const { rows, frame } = at("oc--v226-slash-compact.txt");
    const edited = rows.map((row, i) => (i === frame.interior.prompt ? { segments: [{ text: rowText(row).replace("/compact", "/compacx") }] } : row));
    const derived = findInputFrame(edited, IDLE)!;
    expect(derived.interior.text).toBe("/compacx");
    expect(ownCommandList(edited.map(rowText), derived, IDLE, edited)).toBeNull();
  });
});

describe("a list that holds Enter still reads as a modal (#749, A, the other direction)", () => {
  it.each(["oc--v226-slash-comp.txt", "oc--v226-narrow--slash-comp.txt", "oc--v1195-slash-comp.txt"])("%s: /comp typed, the fill on /review", (name) => {
    const read = own(name);
    expect(read.frame?.interior.text).toBe("/comp");
    expect(read.surface).toMatchObject({ modal: "unreadable", composer: "unknown" });
    expect(isFree(read.surface)).toBe(false);
    expect(at(name).list).toMatchObject({ pointed: "/review", side: "above" });
  });

  it.each(["oc--v226-slash-palette.txt", "oc--v226-narrow--slash-palette.txt", "oc--slash-palette.txt"])("%s: a bare / with the full list, the fill on /agents", (name) => {
    expect(own(name).surface).toMatchObject({ modal: "unreadable", composer: "unknown" });
    expect(at(name).list?.pointed).toBe("/agents");
    expect(at(name).list?.entries).toHaveLength(10);
  });

  it("the typed command's own list read without colour holds Enter too: no pointer is read, none is guessed", () => {
    const rows = unstyled(fixtureRows("oc--v226-slash-compact.txt"));
    const frame = findInputFrame(rows, IDLE)!;
    const texts = rows.map(rowText);
    expect(frame.interior.text).toBe("/compact");
    expect(commandListAt(texts, frame, LIST, rows)?.pointed).toBeNull();
    expect(ownCommandList(texts, frame, IDLE, rows)).toBeNull();
  });

  it.each(["oc--v226-command-palette.txt", "oc--v226-models-picker.txt"])("%s: a picker over the screen is no box at all", (name) => {
    const read = own(name);
    expect(read.frame).toBeNull();
    expect(read.surface.modal).toBe("unreadable");
  });
});

describe("the boxes that hold no list read as before (#749)", () => {
  it.each([
    ["oc--v226-fresh-idle.txt", "empty"],
    ["oc--v226-narrow--fresh-idle.txt", "empty"],
    ["oc--v226-session-idle.txt", "empty"],
    ["oc--v226-paste-200.txt", "draft"],
    ["oc--v226-narrow--paste-600.txt", "draft"],
    ["oc--v1195-paste-600.txt", "draft"],
  ] as const)("%s reads %s, no modal", (name, composer) => {
    expect(own(name).surface).toMatchObject({ turn: "idle", modal: "none", composer });
  });

  it("an entry row is one space then the command and a closing bar; a draft row (two spaces) never is", () => {
    expect(edgeRunListRow("                       ┃ /review       review changes ┃", LIST)).toBe(true);
    expect(edgeRunListRow("  ┃ /x ┃", LIST)).toBe(true);
    expect(edgeRunListRow("                       ┃  /review       review changes ┃", LIST)).toBe(false);
    expect(edgeRunListRow("                       ┃  /compact", LIST)).toBe(false);
    expect(edgeRunListRow("                       ┃ /compact", LIST)).toBe(false);
    expect(edgeRunListRow("                       ┃", LIST)).toBe(false);
    // Another profile's list is never drawn in that run.
    expect(edgeRunListRow("  ┃ /x ┃", idleFor("omp")!.volatile.below.commandList)).toBe(false);
  });
});

describe("the profile fields (#749)", () => {
  const copy = (): JsonObject => JSON.parse(JSON.stringify(PROFILE_FILES.opencode));
  const withList = (list: JsonObject): JsonObject => {
    const raw = copy();
    const below = asJsonObject(asJsonObject(asJsonObject(raw.idle)?.volatile)?.below);
    const before = asJsonObject(below?.commandList);
    if (below === undefined || before === undefined) throw new Error("opencode.json has no command list");
    below.commandList = { ...before, ...list };
    return raw;
  };
  const withPaste = (paste: JsonObject): JsonObject => ({ ...copy(), paste });

  it("the file as written parses", () => {
    expect(parseProfile(PROFILE_FILES.opencode).idle.volatile.below.commandList).toMatchObject({ pointerFill: true, inEdgeRun: true, sides: ["above"] });
  });

  it("inEdgeRun needs the side above, and pointerFill does not go with pointerBold", () => {
    expect(() => parseProfile(withList({ sides: ["under"] }))).toThrow(ProfileError);
    expect(() => parseProfile(withList({ pointerBold: true }))).toThrow(ProfileError);
  });

  it("paste.foldLines is breaks or lines, and only with paste.block", () => {
    expect(parseProfile(withPaste({ bracketed: true, block: true, foldLines: "breaks" })).paste?.foldLines).toBe("breaks");
    expect(() => parseProfile(withPaste({ bracketed: true, block: true, foldLines: "rows" }))).toThrow(ProfileError);
    expect(() => parseProfile(withPaste({ bracketed: true, foldLines: "lines" }))).toThrow(ProfileError);
  });
});
