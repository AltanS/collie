import { beforeAll, expect, test } from "vitest";
import { Rig } from "./leg";
import { editorApi } from "./editor-api";
import { parseAnsi } from "../../src/lib/ansi";
import { splitLines } from "../../src/lib/blocks";
import { asJsonNumber, asJsonObject, asJsonString } from "../../src/lib/json";
import { piAdapter } from "../../src/lib/harness/pi";
import { cancelDialogEditor, prepareDialogEditor, saveDialogEditor } from "../../src/lib/editor-action";
import type { DialogTarget } from "../../src/lib/dialog-guard";
import { submitMultiSelectIntent } from "../../src/lib/multi-select-action";

const rig = new Rig();
const pane = process.env.COLLIE_REVIEW_PANE ?? "w4:p1";
const endpoint = `/api/pane/${encodeURIComponent(pane)}`;
const throughApi = editorApi(rig);
async function target(): Promise<DialogTarget<"multi-select">> {
  const doc = asJsonObject(await rig.get(`${endpoint}?lines=80`));
  const raw = asJsonString(doc?.text), revision = asJsonNumber(doc?.revision);
  if (raw === undefined || revision === undefined) throw new Error("fixture pane returned no text/revision");
  const block = piAdapter.buildBlocks(splitLines(parseAnsi(raw))).find((candidate) => candidate.kind === "multi-select");
  if (block?.multi.phase !== "review") throw new Error("fixture has no complete native review");
  return { paneId: pane, requestedLines: 80, detectedRevision: revision, agent: "pi", kind: "multi-select", model: block.multi };
}
beforeAll(async () => {
  const ready = await rig.until(() => target(), () => true, 20_000, 100);
  if (ready === null) throw new Error("put the isolated review fixture on Submit first");
});

test("reads, saves and returns from a global note without submitting or filling missing answers", async () => {
  const origin = await target();
  const prepared = await throughApi("prepare", () => prepareDialogEditor(origin, "global-note"));
  expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
  if (prepared.status !== "ready") return;
  try {
    const text = "Global from phone\nSecond global line";
    expect(await throughApi("save", () => saveDialogEditor(prepared.seen, text))).toEqual({ status: "sent" });
    const after = await target();
    expect(after.model.phase).toBe("review");
    if (after.model.phase !== "review" || origin.model.phase !== "review") return;
    expect(after.model.incomplete).toBe(origin.model.incomplete);
    expect(after.model.answers).toEqual(origin.model.answers);
    if (after.model.note === undefined) expect(after.model.summaryClipped).toBe(true);
    else expect(after.model.note).toMatchObject({ state: "attached", textComplete: false });
    const read = await throughApi("prepare", () => prepareDialogEditor(after, "global-note"));
    expect(read.status, JSON.stringify(read)).toBe("ready");
    if (read.status === "ready") {
      expect(read.seen.text).toBe(text);
      expect(await throughApi("cancel", () => cancelDialogEditor(read.seen))).toEqual({ status: "sent" });
    }
  } finally {
    const editor = piAdapter.observeDialogEditor?.(splitLines(parseAnsi(await rig.rawScreen(pane))));
    if (editor?.purpose === "global-note") await rig.keys(pane, ["Escape"]);
  }
}, 50_000);

test("refuses a review commit if a visible note or answer changes after the entry guard", async () => {
  const origin = await target();
  const needle = origin.model.note?.text.split("\n")[0] ?? (origin.model.phase === "review" ? origin.model.answers?.[0]?.answer.split("\n")[0] : undefined);
  if (needle === undefined || needle === "") throw new Error("fixture has no visible review text to fault");
  let reads = 0;
  const result = await throughApi("read", () => submitMultiSelectIntent({
    paneId: pane, requestedLines: 80, detectedRevision: origin.detectedRevision, agent: "pi",
    multi: origin.model, intent: { kind: "confirm" }, sleep: async () => undefined,
  }), { transformRead(raw) {
    reads++;
    return reads === 1 ? raw : raw.replace(needle, "Changed from desk");
  } });
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(result.status).toBe("changed");
  const after = (await target()).model;
  expect(after.note).toEqual(origin.model.note);
  if (after.phase === "review" && origin.model.phase === "review") expect(after.answers).toEqual(origin.model.answers);
});
