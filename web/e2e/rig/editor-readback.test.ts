// Real Pi/RPIV pane through the public production action/API boundary. Opt-in isolated rig only.
import { beforeAll, expect, test } from "vitest";
import { Rig } from "./leg";
import { parseAnsi } from "../../src/lib/ansi";
import { lineText, splitLines } from "../../src/lib/blocks";
import { asJsonNumber, asJsonObject, asJsonString } from "../../src/lib/json";
import { editorApi, type ApiFaults } from "./editor-api";
import { hc, herdrJson, muxOf } from "./rig-lib";
import { readPiFrame } from "../../src/lib/harness/pi/ask";
import { piAdapter } from "../../src/lib/harness/pi";
import { cancelDialogEditor, prepareDialogEditor, readDialogEditor, saveDialogEditor } from "../../src/lib/editor-action";
import type { DialogTarget } from "../../src/lib/dialog-guard";

const rig = new Rig();
const pane = process.env.COLLIE_READBACK_PANE ?? "w2:p1";
const endpoint = `/api/pane/${encodeURIComponent(pane)}`;
let inlineWidth = 111, noteWidth = 119, noteViewport = 12;
const wait = async (pattern: RegExp) => {
  const found = await rig.until(() => rig.screen(pane, 40), (text) => pattern.test(text.slice(text.lastIndexOf(" ←"))), 10_000, 80);
  if (found === null) throw new Error(`native setup did not reach ${pattern}`);
};
beforeAll(async () => {
  const frame = readPiFrame(splitLines(parseAnsi(await rig.rawScreen(pane))));
  const core = muxOf("lead") === "herdr-core";
  const nativePane = core ? asJsonObject(JSON.parse(hc(["get", pane, "--json"]).out)) : asJsonObject(herdrJson(["pane", "get", pane]).pane);
  const rows = asJsonNumber(core ? nativePane?.rows : asJsonObject(nativePane?.scroll)?.viewport_rows);
  if (frame === null || rows === undefined) throw new Error("fixture dimensions are unavailable");
  const width = frame.texts[frame.top]!.length;
  inlineWidth = width - 9;
  noteWidth = width - 1;
  noteViewport = Math.max(5, Math.floor(rows * 0.3)); // Pinned Pi 1.4.0's native editor viewport.
  if (!(await rig.screen(pane, 40)).includes("Which checks should the Collie probe run")) {
    await rig.keys(pane, ["Tab"]);
    await wait(/Which checks should the Collie probe run/);
  }
  await focusField();
});
async function focusField(): Promise<boolean> {
  const current = await rig.until(() => multiTarget(), (value) => value.model.phase === "checkbox", 10_000, 80);
  if (current === null) throw new Error("fixture did not restore its complete checkbox card");
  const focus = current.model.editors?.answer?.focusKeys;
  if (focus === undefined) throw new Error("fixture has no native field focus plan");
  if (focus.length > 0) await rig.keys(pane, focus);
  await wait(/❯ 3\. \[/);
  return focus.length > 0;
}
async function seed(text: string) {
  // First clear restores a deliberately clipped synthetic input. A tab may restore its own saved
  // menu pointer (including Next), so re-establish measured field focus before seeding, too.
  await rig.keys(pane, ["ctrl+u"]);
  if (await focusField()) await rig.keys(pane, ["ctrl+u"]);
  await wait(/❯ 3\. \[ \]/);
  if (text === "") return;
  expect((await rig.post(`${endpoint}/reply`, { text, submit: false })).status).toBe(200);
  await wait(/❯ 3\. \[✔\]/);
}

const throughApi = editorApi(rig);
async function read(faults: ApiFaults = {}) {
  const observation = piAdapter.observeDialogEditor?.(splitLines(parseAnsi(await rig.rawScreen(pane))));
  return throughApi("read", () => readDialogEditor({
    paneId: pane, requestedLines: 80, agent: "pi",
    ownerSignature: observation?.ownerSignature ?? "unreadable", purpose: observation?.purpose ?? "answer",
  }), faults);
}
async function multiTarget(): Promise<DialogTarget<"multi-select">> {
  const doc = asJsonObject(await rig.get(`${endpoint}?lines=80`));
  const raw = asJsonString(doc?.text);
  const revision = asJsonNumber(doc?.revision);
  if (raw === undefined || revision === undefined) throw new Error("fixture pane did not return a revision/text");
  const block = piAdapter.buildBlocks(splitLines(parseAnsi(raw))).find((candidate) => candidate.kind === "multi-select");
  if (block === undefined) throw new Error("fixture is not a complete multi-select dialog");
  return { paneId: pane, requestedLines: 80, detectedRevision: revision, agent: "pi", kind: "multi-select", model: block.multi };
}

test("reads an ordinary complete answer without editing or confirming it", async () => {
  await seed("Known answer.");
  const result = await read();
  expect(result.status, JSON.stringify(result)).toBe("read");
  if (result.status === "read") expect(result.text).toBe("Known answer.");
}, 20_000);

test("reads a logical line hidden by native word wrapping", async () => {
  const text = "alpha beta gamma delta ".repeat(7).trim();
  await seed(text);
  const snapshots: unknown[] = [];
  const result = await read({ transformRead(raw) {
    const observed = piAdapter.observeDialogEditor?.(splitLines(parseAnsi(raw)));
    snapshots.push({ rows: observed?.rows, cursor: observed?.cursor });
    return raw;
  } });
  expect(result.status, JSON.stringify({ result, snapshots })).toBe("read");
  if (result.status === "read") expect(result.text).toBe(text);
}, 30_000);

test("does not adopt changed authored choices while probing the editor", async () => {
  await seed("Known answer.");
  let changed = false;
  let retargeted = false;
  let injected = false;
  const result = await read({
    transformRead(raw) {
      if (!changed) return raw;
      const modified = raw.replaceAll("Unit tests", "Desk-replaced option");
      injected ||= modified !== raw;
      return modified;
    },
    async afterWrite(body) {
      retargeted ||= asJsonString(body.expected_prompt)?.includes("Desk-replaced option") ?? false;
      changed = true;
    },
  });
  expect(result.status).toBe("changed");
  expect(injected).toBe(true);
  expect(retargeted).toBe(false);
}, 20_000);

test("refuses a visible whitespace-only desk edit during answer readback", async () => {
  await seed("Known answer.");
  let injected = false;
  const result = await read({
    async afterWrite() {
      if (injected) return;
      injected = true;
      await rig.keys(pane, ["ctrl+u"]);
      expect((await rig.post(`${endpoint}/reply`, { text: "Known  answer.", submit: false })).status).toBe(200);
      await wait(/Known  answer\./);
      await rig.keys(pane, ["ctrl+a"]);
    },
  });
  expect(injected).toBe(true);
  expect(result.status).toBe("changed");
  expect(await rig.screen(pane, 40)).toContain("Known  answer.");
}, 20_000);

test.each([
  () => "", () => "x".repeat(240), () => "First line\nSecond line", () => "中文 👩‍💻 e\u0301\nNoël",
  () => "x".repeat(inlineWidth), () => "x".repeat(inlineWidth - 3) + "   Z", () => "x".repeat(inlineWidth - 1) + "\u00a0Y",
])("reads an exact native value, including empty/limit/Unicode/wrap boundaries (%#)", async (value) => {
  const text = value();
  await seed(text);
  let cursorSteps = 0;
  const result = await read({ async afterWrite(body) {
    if (Array.isArray(body.keys)) cursorSteps += body.keys.filter(key => key === "Right" || key === "Left").length;
  } });
  expect(result.status, JSON.stringify(result)).toBe("read");
  if (result.status === "read") expect(result.text).toBe(text);
  // A wrapped value must not replay every proved prefix: hc paces each key separately.
  if (text === "x".repeat(240)) expect(cursorSteps).toBeLessThanOrEqual(240);
}, 30_000);

test.each([
  ["return", "x".repeat(240)],
  ["return", "A\n" + "x".repeat(161)],
  ["save", "A\n" + "x".repeat(161)],
] as const)("%s leaves a wrapped native answer without changing its logical value or other choices (%#)", async (operation, text) => {
  await seed(operation === "save" ? "Old value" : text);
  const origin = await multiTarget();
  const options = origin.model.phase === "checkbox" ? origin.model.options : [];
  const prepared = await throughApi("prepare", () => prepareDialogEditor(origin, "answer"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  const result = operation === "save" ? await throughApi("save", () => saveDialogEditor(prepared.seen, text)) :
    await throughApi("cancel", () => cancelDialogEditor(prepared.seen));
  expect(result).toEqual({ status: "sent" });
  const after = await multiTarget();
  expect(after.model.phase).toBe("checkbox");
  if (after.model.phase === "checkbox") {
    expect(after.model.field?.focused).toBe(false);
    expect(after.model.options).toEqual(options);
  }
  const reread = await throughApi("prepare", () => prepareDialogEditor(after, "answer"));
  expect(reread.status, JSON.stringify(reread)).toBe("ready");
  if (reread.status === "ready") expect(reread.seen.text).toBe(text);
}, 40_000);

test("refuses 241 characters rather than truncating the answer", async () => {
  await seed("x".repeat(241));
  expect(await read()).toMatchObject({ status: "changed", why: "complete value exceeds phone limit" });
}, 30_000);

test("refuses a clipped inline editor below the character limit", async () => {
  await seed("x\n".repeat(35) + "CLIP_LAST");
  expect((await read()).status).toBe("changed");
}, 20_000);

test("refuses a desk text edit and preserves the newly authored value", async () => {
  await seed("Known answer.");
  let injected = false;
  const result = await read({ async afterWrite() {
    if (injected) return;
    injected = true;
    await rig.post(`${endpoint}/reply`, { text: "Desk change ", submit: false });
    await wait(/Desk change/);
    await rig.keys(pane, ["ctrl+a"]);
  } });
  expect(injected).toBe(true);
  expect(result.status).toBe("changed");
  expect(await rig.screen(pane, 40)).toContain("Desk change");
}, 20_000);

test.each([
  ["two logical lines", (): string => "First note line\nSecond note line", false, "read", false],
  ["visible whitespace drift", (): string => "First note line\nSecond note line", false, "drift", false],
  ["one wrapped logical line", () => "alpha beta gamma delta ".repeat(7).trim(), false, "read", false],
  ["a wrap-edge space run", () => "x".repeat(noteWidth - 2) + "   Y", false, "read", false],
  ["a global scope", (): string => "Global first line\nGlobal second line", true, "read", false],
  ["the inclusive 300-character limit", () => "x".repeat(300), false, "read", false],
  ["301 characters", () => "x".repeat(301), false, "over-limit", false],
  ["an unproved whitespace-only tail", () => "x".repeat(noteWidth) + " ", false, "unproved", false],
  ["a literal rule", () => "Begin\n" + "─".repeat(30) + "\nEnd", false, "read", true],
  ["the complete note viewport", () => "row\n".repeat(noteViewport - 1) + "LAST", false, "read", false],
  ["a clipped viewport", () => "row\n".repeat(15) + "LAST", false, "clipped", false],
] as const)("reads or refuses a native note with %s without closing it", async (_name, value, global, outcome, early) => {
  const text = value();
  await seed("");
  await rig.keys(pane, ["Up"]);
  await wait(/❯ 2\. \[/);
  if (global) await rig.keys(pane, ["Tab", "Tab", "Tab"]);
  await rig.keys(pane, ["n"]);
  await wait(global ? /Global note:/ : /Notes:/);
  try {
    // Destructive setup/cleanup touches only synthetic notes, never the audited read recipe.
    await rig.keys(pane, Array.from({ length: 16 }, () => ["ctrl+a", "ctrl+k", "Backspace"]).flat());
    await wait(/ (?:Notes|Global note): *\r?\n─+ *\r?\n *\r?\n─+/);
    expect((await rig.post(`${endpoint}/reply`, { text, submit: false })).status).toBe(200);
    if (outcome === "clipped") await wait(/↑ \d+ more/);
    else {
      const marker = text.trimEnd().match(/\S+$/)![0].slice(-24);
      const arrived = await rig.until(() => rig.screen(pane, 40), (screen) =>
        screen.slice(screen.lastIndexOf(global ? " Global note:" : " Notes:"), screen.lastIndexOf(" Enter to select")).includes(marker), 10_000, 80);
      if (arrived === null) throw new Error("fixture note payload did not arrive");
    }
    if (early) {
      await rig.keys(pane, ["ctrl+a", "Up", "ctrl+a", "Up", "ctrl+a"]);
      const landed = await rig.until(() => rig.rawScreen(pane, 80), (raw) => splitLines(parseAnsi(raw)).some((line) =>
        lineText(line).startsWith("Begin") && line.segments.some((segment) => segment.bg !== undefined)), 10_000, 80);
      if (landed === null) throw new Error("fixture caret did not reach the first note line");
    }
    let injected = false;
    const result = await read(outcome === "drift" ? { async afterWrite() {
      if (injected) return;
      injected = true;
      expect((await rig.post(`${endpoint}/reply`, { text: " ", submit: false })).status).toBe(200);
      await wait(/\r?\n Second note line/);
      await rig.keys(pane, ["ctrl+a"]);
    } } : {});
    if (outcome === "read") {
      expect(result.status, JSON.stringify(result)).toBe("read");
      if (result.status === "read") expect(result.text).toBe(text);
    } else expect(result.status, JSON.stringify(result)).toBe("changed");
    if (outcome === "drift") expect(injected).toBe(true);
    expect(await rig.screen(pane, 40)).toContain(global ? "Global note:" : "Notes:");
  } finally {
    await rig.keys(pane, ["Escape"]); // Native save/close is fixture cleanup, not a read operation.
    if (global) {
      await rig.keys(pane, ["Tab", "Tab"]);
      await wait(/Which checks should the Collie probe run/);
    }
    await focusField();
  }
}, 30_000);

async function seedNote(text: string) {
  await seed("Native answer.");
  await rig.keys(pane, ["Up"]);
  await wait(/❯ 2\. \[/);
  await rig.keys(pane, ["n"]);
  await wait(/Notes:/);
  await rig.keys(pane, Array.from({ length: 16 }, () => ["ctrl+a", "ctrl+k", "Backspace"]).flat());
  await wait(/ Notes: *\r?\n─+ *\r?\n *\r?\n─+/);
  expect((await rig.post(`${endpoint}/reply`, { text, submit: false })).status).toBe(200);
  await wait(/Second note line/);
  await rig.keys(pane, ["Escape"]);
  await wait(/Note for this answer:/);
}

async function restoreFieldAfterNote() {
  const editor = piAdapter.observeDialogEditor?.(splitLines(parseAnsi(await rig.rawScreen(pane))));
  if (editor?.purpose === "question-note") await rig.keys(pane, ["Escape"]);
  await wait(/❯ 2\. \[/);
  await rig.keys(pane, ["Down"]);
  await wait(/❯ 3\. \[/);
}

test("prepares a note from its full native value, not its first-line summary", async () => {
  const text = "First note line\nSecond note line";
  await seedNote(text);
  try {
    const origin = await multiTarget();
    const result = await throughApi("prepare", () => prepareDialogEditor(origin, "question-note"));
    expect(result.status, JSON.stringify(result)).toBe("ready");
    if (result.status === "ready") {
      expect(result.seen.text).toBe(text);
      expect(result.seen.origin).toEqual(origin);
    }
    expect(await rig.screen(pane, 40)).toContain(" Notes:");
  } finally {
    await restoreFieldAfterNote();
  }
}, 30_000);

test("returns from an unchanged owned note without changing its text or other answers", async () => {
  const text = "First note line\nSecond note line";
  await seedNote(text);
  const origin = await multiTarget();
  const prepared = await throughApi("prepare", () => prepareDialogEditor(origin, "question-note"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  try {
    expect(await throughApi("cancel", () => cancelDialogEditor(prepared.seen))).toEqual({ status: "sent" });
    const after = await multiTarget();
    expect(after.model).toMatchObject({ note: { state: "attached", text: "First note line …" } });
    if (origin.model.phase === "checkbox" && after.model.phase === "checkbox") expect(after.model.options).toEqual(origin.model.options);
    const reopened = await throughApi("prepare", () => prepareDialogEditor(after, "question-note"));
    expect(reopened.status, JSON.stringify(reopened)).toBe("ready");
    if (reopened.status === "ready") expect(reopened.seen.text).toBe(text);
  } finally {
    await restoreFieldAfterNote();
  }
}, 30_000);

test("replaces a note only after restoring the complete original dialog and re-reading it", async () => {
  await seedNote("First note line\nSecond note line");
  const origin = await multiTarget();
  const prepared = await throughApi("prepare", () => prepareDialogEditor(origin, "question-note"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  const text = "Replacement first\n  Indented second\n";
  try {
    expect(await throughApi("save", () => saveDialogEditor(prepared.seen, text))).toEqual({ status: "sent" });
    const after = await multiTarget();
    if (origin.model.phase === "checkbox" && after.model.phase === "checkbox") {
      expect(after.model.options).toEqual(origin.model.options);
      expect(after.model.field?.text).toBe("Native answer.");
    }
    const reopened = await throughApi("prepare", () => prepareDialogEditor(after, "question-note"));
    expect(reopened.status, JSON.stringify(reopened)).toBe("ready");
    if (reopened.status === "ready") expect(reopened.seen.text).toBe(text.trim());
  } finally {
    await restoreFieldAfterNote();
  }
}, 45_000);

test.each(["save", "cancel"] as const)("refuses %s after a desk edit, without clearing or closing the changed note", async (operation) => {
  await seedNote("First note line\nSecond note line");
  const prepared = await throughApi("prepare", async () => prepareDialogEditor(await multiTarget(), "question-note"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  try {
    expect((await rig.post(`${endpoint}/reply`, { text: "Desk change", submit: false })).status).toBe(200);
    await wait(/Desk change/);
    // Even though this is a save/return entry point, a stale value must emit READ KEYS ONLY.
    const result = await throughApi("read", () => operation === "save" ? saveDialogEditor(prepared.seen, "Phone draft") : cancelDialogEditor(prepared.seen));
    expect(result.status, JSON.stringify(result)).toBe("changed");
    const screen = await rig.screen(pane, 40);
    expect(screen).toContain(" Notes:");
    expect(screen).toContain("Desk change");
  } finally {
    await restoreFieldAfterNote();
  }
}, 30_000);

test("refuses replacement if the complete dialog changes at the close/reopen boundary", async () => {
  await seedNote("First note line\nSecond note line");
  const prepared = await throughApi("prepare", async () => prepareDialogEditor(await multiTarget(), "question-note"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  let injected = false;
  let erased = false;
  try {
    const result = await throughApi("save", () => saveDialogEditor(prepared.seen, "Phone draft"), {
      transformRead(raw) {
        const observation = piAdapter.observeDialogEditor?.(splitLines(parseAnsi(raw)));
        if (observation?.purpose === "question-note") return raw;
        const modified = raw.replaceAll("Unit tests", "Changed complete-dialog choice");
        injected ||= modified !== raw;
        return modified;
      },
      async afterWrite(body) {
        const keys = Array.isArray(body.keys) ? body.keys.map(asJsonString) : [];
        erased ||= body.text !== undefined || keys.some((key) => key === "ctrl+k" || key === "Backspace" || key === "ctrl+u");
      },
    });
    expect(result.status, JSON.stringify(result)).toBe("changed");
    expect(injected).toBe(true);
    expect(erased).toBe(false);
    expect(await rig.screen(pane, 40)).toContain("Note for this answer: First note line …");
  } finally {
    await restoreFieldAfterNote();
  }
}, 30_000);

test.each(["", "x".repeat(300)])("saves an explicit note removal or inclusive-limit replacement (%#)", async (text) => {
  await seedNote("First note line\nSecond note line");
  const prepared = await throughApi("prepare", async () => prepareDialogEditor(await multiTarget(), "question-note"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  try {
    expect(await throughApi("save", () => saveDialogEditor(prepared.seen, text))).toEqual({ status: "sent" });
    const after = await multiTarget();
    expect(after.model.note?.state).toBe(text === "" ? "none" : "attached");
    const reopened = await throughApi("prepare", () => prepareDialogEditor(after, "question-note"));
    expect(reopened.status, JSON.stringify(reopened)).toBe("ready");
    if (reopened.status === "ready") expect(reopened.seen.text).toBe(text);
  } finally {
    await restoreFieldAfterNote();
  }
}, 45_000);

test("replaces a multiline custom answer without committing or changing other checkboxes", async () => {
  await seed("Existing answer.");
  const origin = await multiTarget();
  const prepared = await throughApi("prepare", () => prepareDialogEditor(origin, "answer"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  const text = "First answer line\n  Indented second line\n";
  try {
    expect(await throughApi("save", () => saveDialogEditor(prepared.seen, text))).toEqual({ status: "sent" });
    const after = await multiTarget();
    if (after.model.phase === "checkbox" && origin.model.phase === "checkbox") {
      expect(after.model.field?.text).toBe(text);
      expect(after.model.field?.checked).toBe(true);
      expect(after.model.field?.focused).toBe(false);
      expect(after.model.options).toEqual(origin.model.options);
    }
    const reopened = await throughApi("prepare", () => prepareDialogEditor(after, "answer"));
    expect(reopened.status, JSON.stringify(reopened)).toBe("ready");
    if (reopened.status === "ready") {
      expect(reopened.seen.text).toBe(text);
      expect(await throughApi("cancel", () => cancelDialogEditor(reopened.seen))).toEqual({ status: "sent" });
    }
  } finally {
    if ((await rig.screen(pane, 40)).includes("❯ 2. [")) await rig.keys(pane, ["Down"]);
    await wait(/❯ 3\. \[/);
  }
}, 45_000);

test("does not adopt a changed header style", async () => {
  await seed("Known answer.");
  let changed = false;
  let injected = false;
  let retargeted = false;
  const result = await read({
    transformRead(raw) {
      if (!changed) return raw;
      return raw.split("\n").map((line) => {
        if (!line.includes("✓ Submit")) return line;
        const modified = line.replace(/48;2;\d+;\d+;\d+/g, "48;2;7;17;23");
        injected ||= modified !== line;
        return modified;
      }).join("\n");
    },
    async afterWrite(body) {
      retargeted ||= asJsonString(body.expected_styled)?.includes("bg=rgb(7,17,23)") ?? false;
      changed = true;
    },
  });
  expect(result.status).toBe("changed");
  expect(injected).toBe(true);
  expect(retargeted).toBe(false);
}, 20_000);
