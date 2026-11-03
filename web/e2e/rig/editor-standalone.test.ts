import { expect, test } from "vitest";
import { Rig } from "./leg";
import { editorApi } from "./editor-api";
import { parseAnsi } from "../../src/lib/ansi";
import { splitLines } from "../../src/lib/blocks";
import { asJsonNumber, asJsonObject, asJsonString } from "../../src/lib/json";
import { piAdapter } from "../../src/lib/harness/pi";
import { submitMultiSelectIntent } from "../../src/lib/multi-select-action";
import { cancelDialogEditor, prepareDialogEditor, saveDialogEditor } from "../../src/lib/editor-action";

const rig = new Rig();
const pane = process.env.COLLIE_STANDALONE_PANE ?? "";
if (!pane) throw new Error("set COLLIE_STANDALONE_PANE to the disposable standalone fixture's returned pane id");
const endpoint = `/api/pane/${encodeURIComponent(pane)}`;
async function snapshot() {
  const doc = asJsonObject(await rig.get(`${endpoint}?lines=80`));
  const text = asJsonString(doc?.text), revision = asJsonNumber(doc?.revision);
  if (text === undefined || revision === undefined) throw new Error("standalone fixture has no text/revision");
  const block = piAdapter.buildBlocks(splitLines(parseAnsi(text))).find((candidate) => candidate.kind === "multi-select");
  if (block?.multi.phase !== "checkbox" || block.multi.steps !== null) throw new Error("fixture must be a standalone checkbox question");
  return { paneId: pane, requestedLines: 80, detectedRevision: revision, agent: "pi", kind: "multi-select" as const, model: block.multi };
}
const throughApi = editorApi(rig);
async function seed(text: string) {
  let origin = await snapshot();
  if (!origin.model.options[0]?.checked) {
    if (origin.model.pointerRow !== origin.model.options[0]?.n) throw new Error("start a fresh standalone fixture with its first option pointed");
    await rig.keys(pane, ["Space"]); // Keep an authored selection alongside the custom value.
    const checked = await rig.until(() => snapshot(), (value) => value.model.options[0]?.checked === true, 10_000, 80);
    if (!checked) throw new Error("standalone fixture did not check its first option");
    origin = checked;
  }
  const focus = origin.model.editors?.answer?.focusKeys;
  if (!focus) throw new Error("standalone fixture has no native custom-answer focus plan");
  // Synthetic setup, outside the audited production read/edit operation.
  if (focus.length) await rig.keys(pane, focus);
  await rig.keys(pane, ["ctrl+u"]);
  if (text) expect((await rig.post(`${endpoint}/reply`, { text, submit: false })).status).toBe(200);
  const seeded = await rig.until(() => snapshot(), (value) => value.model.phase === "checkbox" &&
    value.model.field?.focused === true && value.model.field.text === text, 10_000, 80);
  if (!seeded) throw new Error("standalone fixture did not paint its seeded answer");
  return seeded;
}

test("reads and returns a standalone Submit checkbox's complete multiline answer", async () => {
  const text = "Existing standalone\n  Original final\n";
  const origin = await seed(text);
  const prepared = await throughApi("prepare", () => prepareDialogEditor(origin, "answer"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  expect(prepared.seen.text).toBe(text);
  expect(await throughApi("cancel", () => cancelDialogEditor(prepared.seen))).toEqual({ status: "sent" });
  const after = await snapshot();
  if (after.model.phase !== "checkbox" || origin.model.phase !== "checkbox") throw new Error("standalone checkbox did not return");
  expect(after.model.field?.focused).toBe(false);
  expect(after.model.options).toEqual(origin.model.options);
  const reread = await throughApi("prepare", () => prepareDialogEditor(after, "answer"));
  expect(reread.status, JSON.stringify(reread)).toBe("ready");
  if (reread.status === "ready") expect(reread.seen.text).toBe(text);
}, 40_000);

test.each(["A\n" + "x".repeat(161), "x".repeat(240)])("saves an exact wrapped/limit standalone answer without changing authored choices (%#)", async (text) => {
  const origin = await seed("Old standalone answer");
  const prepared = await throughApi("prepare", () => prepareDialogEditor(origin, "answer"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  expect(prepared.seen.text).toBe("Old standalone answer");
  expect(await throughApi("save", () => saveDialogEditor(prepared.seen, text))).toEqual({ status: "sent" });
  const after = await snapshot();
  if (after.model.phase !== "checkbox" || origin.model.phase !== "checkbox") throw new Error("standalone checkbox did not return");
  expect(after.model.field?.focused).toBe(false);
  expect(after.model.field?.checked).toBe(true);
  expect(after.model.options).toEqual(origin.model.options);
  const reread = await throughApi("prepare", () => prepareDialogEditor(after, "answer"));
  expect(reread.status, JSON.stringify(reread)).toBe("ready");
  if (reread.status === "ready") expect(reread.seen.text).toBe(text);
}, 40_000);

test("explicitly clears the complete standalone custom value without removing authored selections", async () => {
  const text = "Clear this\n  Full standalone\n";
  const origin = await seed(text);
  const prepared = await throughApi("prepare", () => prepareDialogEditor(origin, "answer"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  expect(prepared.seen.text).toBe(text);
  expect(await throughApi("save", () => saveDialogEditor(prepared.seen, ""))).toEqual({ status: "sent" });
  const after = await snapshot();
  if (after.model.phase !== "checkbox" || origin.model.phase !== "checkbox") throw new Error("standalone checkbox did not return");
  expect(after.model.field).toMatchObject({ focused: false, checked: false, text: "" });
  expect(after.model.options).toEqual(origin.model.options);
  const reread = await throughApi("prepare", () => prepareDialogEditor(after, "answer"));
  expect(reread.status, JSON.stringify(reread)).toBe("ready");
  if (reread.status === "ready") expect(reread.seen.text).toBe("");
}, 40_000);

test("binds every standalone multi-select advance step, including its final committing Enter", async () => {
  let origin = await snapshot();
  if (!origin.model.options[0]?.checked) {
    await rig.keys(pane, ["Space"]); // Synthetic setup, outside the audited production action.
    const checked = await rig.until(() => snapshot(), (value) => value.model.options[0]?.checked === true, 10_000, 80);
    if (checked === null) throw new Error("fixture did not check its first option");
    origin = checked;
  }
  const keys: string[] = [];
  const result = await editorApi(rig)("commit", () => submitMultiSelectIntent({
    paneId: pane, requestedLines: 80, detectedRevision: origin.detectedRevision, agent: "pi", multi: origin.model,
    intent: { kind: "advance" },
  }), { async afterWrite(body) {
    if (Array.isArray(body.keys)) keys.push(...body.keys.flatMap((value) => {
      const key = asJsonString(value);
      return key === undefined ? [] : [key];
    }));
  } });
  expect(result).toEqual({ status: "sent" });
  expect(keys.length).toBeGreaterThan(1);
  expect(keys.at(-1)).toBe("Enter");
}, 30_000);
