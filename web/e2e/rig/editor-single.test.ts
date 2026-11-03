import { beforeAll, expect, test } from "vitest";
import { Rig } from "./leg";
import { editorApi } from "./editor-api";
import { parseAnsi } from "../../src/lib/ansi";
import { splitLines } from "../../src/lib/blocks";
import { asJsonNumber, asJsonObject, asJsonString } from "../../src/lib/json";
import { piAdapter } from "../../src/lib/harness/pi";
import { cancelDialogEditor, prepareDialogEditor, saveDialogEditor } from "../../src/lib/editor-action";
import type { DialogTarget } from "../../src/lib/dialog-guard";

const rig = new Rig();
const pane = process.env.COLLIE_SINGLE_PANE ?? "w3:p1";
const endpoint = `/api/pane/${encodeURIComponent(pane)}`;
const throughApi = editorApi(rig);
const delivery = "How should the Collie probe describe delivery?";
async function target(): Promise<DialogTarget<"preview-select">> {
  const doc = asJsonObject(await rig.get(`${endpoint}?lines=80`));
  const raw = asJsonString(doc?.text), revision = asJsonNumber(doc?.revision);
  if (raw === undefined || revision === undefined) throw new Error("fixture pane returned no text/revision");
  const block = piAdapter.buildBlocks(splitLines(parseAnsi(raw))).find((candidate) => candidate.kind === "preview-select");
  if (block === undefined) throw new Error("fixture has no complete single-choice card");
  return { paneId: pane, requestedLines: 80, detectedRevision: revision, agent: "pi", kind: "preview-select", model: block.preview };
}
async function atDelivery() {
  for (let count = 0; count < 5; count++) {
    let current = await target();
    if (current.model.field?.focused) {
      const prepared = await throughApi("prepare", () => prepareDialogEditor(current, "answer"));
      if (prepared.status !== "ready") throw new Error("fixture could not read its existing input");
      expect(await throughApi("cancel", () => cancelDialogEditor(prepared.seen))).toEqual({ status: "sent" });
      current = await target();
    }
    if (current.model.question === delivery) return current;
    // Fixture-only navigation: skip the checkbox tab from Plan; return one tab from Optional.
    const keys = current.model.question.includes("implementation") ? ["Tab", "Tab"] : ["Left"];
    expect((await rig.post(`${endpoint}/keys`, { keys })).status).toBe(200);
    const changed = await rig.until(() => target(), (next) => next.model.question !== current.model.question, 10_000, 80);
    if (changed === null) throw new Error("fixture tab did not change");
  }
  throw new Error("fixture did not reach Delivery");
}
beforeAll(async () => {
  const ready = await rig.until(() => target(), () => true, 30_000, 100);
  if (ready === null) throw new Error("launch the isolated native single-choice fixture first");
  await atDelivery();
});
async function seed(text: string) {
  const prepared = await throughApi("prepare", async () => prepareDialogEditor(await atDelivery(), "answer"));
  if (prepared.status !== "ready") throw new Error("fixture could not focus its input");
  expect((await rig.post(`${endpoint}/keys`, { keys: ["ctrl+u"] })).status).toBe(200);
  const empty = await rig.until(() => rig.rawScreen(pane), (raw) => {
    const editor = piAdapter.observeDialogEditor?.(splitLines(parseAnsi(raw)));
    return editor?.rows.length === 1 && editor.rows[0] === "\u00a0" && editor.cursor.offset === 0;
  }, 10_000, 80);
  if (empty === null) throw new Error("fixture field did not clear");
  if (text !== "") {
    expect((await rig.post(`${endpoint}/reply`, { text, submit: false })).status).toBe(200);
    const arrived = await rig.until(() => rig.rawScreen(pane), (raw) => {
      const editor = piAdapter.observeDialogEditor?.(splitLines(parseAnsi(raw)));
      return editor?.rows.join("").replace(/\s/gu, "") === text.replace(/\s/gu, "");
    }, 10_000, 80);
    if (arrived === null) throw new Error("fixture field value did not arrive");
  }
}

test("reads a single-choice value including real blank tails, then returns without confirming it", async () => {
  const text = "Current custom\nSecond custom line\n\n";
  await seed(text);
  const prepared = await throughApi("prepare", async () => prepareDialogEditor(await target(), "answer"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  expect(prepared.seen.text).toBe(text);
  expect(await throughApi("cancel", () => cancelDialogEditor(prepared.seen))).toEqual({ status: "sent" });
  expect((await target()).model.question).toBe(delivery);
}, 40_000);

test("edits a question note while preserving its side-by-side preview and unanswered status", async () => {
  await atDelivery();
  expect((await rig.post(`${endpoint}/keys`, { keys: ["Left", "Left"] })).status).toBe(200);
  const plan = await rig.until(() => target(), (next) => next.model.question.includes("implementation"), 10_000, 80);
  if (plan === null) throw new Error("fixture did not reach the preview question");
  const prepared = await throughApi("prepare", () => prepareDialogEditor(plan, "question-note"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  try {
    const text = "Preview first note\nPreview second note";
    expect(await throughApi("save", () => saveDialogEditor(prepared.seen, text))).toEqual({ status: "sent" });
    const after = await target();
    expect(after.model.preview.join("\n")).toContain("Plan A");
    expect(after.model.steps?.find((step) => step.current)?.answered).toBe(plan.model.steps?.find((step) => step.current)?.answered);
    const reread = await throughApi("prepare", () => prepareDialogEditor(after, "question-note"));
    expect(reread.status, JSON.stringify(reread)).toBe("ready");
    if (reread.status === "ready") {
      expect(reread.seen.text).toBe(text);
      expect(await throughApi("cancel", () => cancelDialogEditor(reread.seen))).toEqual({ status: "sent" });
    }
  } finally {
    const editor = piAdapter.observeDialogEditor?.(splitLines(parseAnsi(await rig.rawScreen(pane))));
    if (editor?.purpose === "question-note") await rig.keys(pane, ["Escape"]);
  }
}, 45_000);

test("keeps select identity when a preview gives way to the custom input and back", async () => {
  await atDelivery();
  expect((await rig.post(`${endpoint}/keys`, { keys: ["Left", "Left"] })).status).toBe(200);
  const plan = await rig.until(() => target(), (next) => next.model.question.includes("implementation"), 10_000, 80);
  if (plan === null) throw new Error("fixture did not reach Plan");
  const prepared = await throughApi("prepare", () => prepareDialogEditor(plan, "answer"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  const text = "Own preview plan\nNext line";
  expect(await throughApi("commit", () => saveDialogEditor(prepared.seen, text))).toEqual({ status: "sent" });
  const checks = await rig.until(() => rig.screen(pane), (screen) => screen.slice(screen.lastIndexOf(" ←")).includes("Which checks should"), 10_000, 80);
  expect(checks).not.toBeNull();
  expect((await rig.post(`${endpoint}/keys`, { keys: ["Left"] })).status).toBe(200);
  const back = await rig.until(() => target(), (next) => next.model.question.includes("implementation"), 10_000, 80);
  if (back === null) throw new Error("fixture did not return to Plan");
  const reread = await throughApi("prepare", () => prepareDialogEditor(back, "answer"));
  expect(reread.status, JSON.stringify(reread)).toBe("ready");
  if (reread.status === "ready") {
    expect(reread.seen.text).toBe(text);
    expect(await throughApi("cancel", () => cancelDialogEditor(reread.seen))).toEqual({ status: "sent" });
  }
}, 50_000);

test("saves the exact custom value with one declared committing Enter and advances only this question", async () => {
  await seed("Old single value");
  const prepared = await throughApi("prepare", async () => prepareDialogEditor(await target(), "answer"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  const text = "Phone single\n  Exact second\n";
  const commits: string[] = [];
  expect(await throughApi("commit", () => saveDialogEditor(prepared.seen, text), { async afterWrite(body) {
    if (Array.isArray(body.keys)) commits.push(...body.keys.flatMap((value) => asJsonString(value) === "Enter" ? ["Enter"] : []));
  } })).toEqual({ status: "sent" });
  const advanced = await rig.until(() => target(), (next) => next.model.question.includes("optional platform"), 10_000, 80);
  expect(advanced).not.toBeNull();
  expect(commits).toEqual(["Enter"]);
  const revisited = await atDelivery();
  const read = await throughApi("prepare", () => prepareDialogEditor(revisited, "answer"));
  expect(read.status, JSON.stringify(read)).toBe("ready");
  if (read.status === "ready") {
    expect(read.seen.text).toBe(text);
    expect(await throughApi("cancel", () => cancelDialogEditor(read.seen))).toEqual({ status: "sent" });
  }
}, 50_000);
