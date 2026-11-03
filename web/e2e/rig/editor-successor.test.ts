import { expect, test } from "vitest";
import { Rig } from "./leg";
import { editorApi } from "./editor-api";
import { parseAnsi } from "../../src/lib/ansi";
import { splitLines } from "../../src/lib/blocks";
import { asJsonNumber, asJsonObject, asJsonString } from "../../src/lib/json";
import { piAdapter } from "../../src/lib/harness/pi";
import { prepareDialogEditor } from "../../src/lib/editor-action";
import type { DialogTarget } from "../../src/lib/dialog-guard";

const rig = new Rig();
const pane = process.env.COLLIE_SUCCESSOR_PANE ?? "";
if (!pane) throw new Error("set COLLIE_SUCCESSOR_PANE to the disposable two-call fixture's returned pane id");
const endpoint = `/api/pane/${encodeURIComponent(pane)}`;
async function snapshot(): Promise<DialogTarget<"preview-select">> {
  const doc = asJsonObject(await rig.get(`${endpoint}?lines=80`));
  const text = asJsonString(doc?.text), revision = asJsonNumber(doc?.revision);
  if (text === undefined || revision === undefined) throw new Error("race fixture has no text/revision");
  const block = piAdapter.buildBlocks(splitLines(parseAnsi(text))).find((candidate) => candidate.kind === "preview-select");
  if (block === undefined) throw new Error("race fixture has no complete single-choice card");
  return { paneId: pane, requestedLines: 80, detectedRevision: revision, agent: "pi", kind: "preview-select", model: block.preview };
}

test("refuses to adopt a real successor with the same heading/caption but different choices at the focus boundary", async () => {
  const first = await rig.until(() => snapshot(), (value) => value.model.options[0]?.label === "Old A", 20_000, 80);
  if (first === null) throw new Error("start the two-call first/second race fixture before this test");
  await rig.keys(pane, ["Down", "Down"]);
  const focused = await rig.until(() => snapshot(), (value) => value.model.field?.focused === true, 10_000, 80);
  if (focused === null) throw new Error("fixture input did not focus");
  expect((await rig.post(`${endpoint}/reply`, { text: "Old draft", submit: false })).status).toBe(200);
  const filled = await rig.until(() => snapshot(), (value) => value.model.field?.text === "Old draft", 10_000, 80);
  if (filled === null) throw new Error("fixture input was not seeded");
  await rig.keys(pane, ["Up"]);
  const origin = await rig.until(() => snapshot(), (value) => value.model.field?.focused === false, 10_000, 80);
  if (origin === null) throw new Error("fixture input did not park");
  let replaced = false;
  try {
    const result = await editorApi(rig)("prepare", () => prepareDialogEditor(origin, "answer"), { async afterWrite() {
      if (replaced) return;
      replaced = true;
      // Independent fixture action: finish the first native tool, allowing the real agent's second
      // call. These absolute Rig calls are outside the audited read/prepare API, not private mocks.
      await rig.keys(pane, ["Enter"]);
      const next = await rig.until(() => snapshot(), (value) => value.model.options[0]?.label === "New A", 20_000, 100);
      if (next === null) throw new Error("the native successor did not open");
      expect(next.model.editors?.ownerSignature).toBe(origin.model.editors?.ownerSignature);
      await rig.keys(pane, ["Down", "Down"]);
      const entered = await rig.until(() => snapshot(), (value) => value.model.field?.focused === true, 10_000, 80);
      if (entered === null) throw new Error("successor input did not focus");
    } });
    expect(replaced).toBe(true);
    expect(result.status, JSON.stringify(result)).toBe("changed");
    expect((await snapshot()).model.options[0]?.label).toBe("New A");
  } finally {
    await rig.keys(pane, ["Escape"]); // Dispose only the synthetic successor questionnaire.
  }
}, 60_000);
