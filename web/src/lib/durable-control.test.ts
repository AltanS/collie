import { describe, expect, it } from "vitest";

import type { ControlResult } from "./api";
import { t } from "./i18n";
import {
  controlTarget,
  intentKey,
  noteKey,
  readControl,
  readThrown,
  requestIdFor,
  steerOffered,
  stopOffered,
} from "./durable-control";
import type { Ask } from "./types";

const ask = (id: string): Ask => ({
  id,
  kind: "permission",
  toolCallId: `call-${id}`,
  revision: 1,
  title: "T",
  itemId: "i",
  options: [{ id: "yes", label: "Yes", effect: "allow" }],
});

describe("which name a control carries", () => {
  it("the turn the phone saw", () => {
    expect(controlTarget({ turnId: "t1", asks: [ask("a1")] })).toEqual({ turnId: "t1" });
  });

  it("the oldest open ask when there is no turn yet", () => {
    expect(controlTarget({ asks: [ask("a1"), ask("a2")] })).toEqual({ askId: "a1" });
  });

  it("nothing when the pane has shown neither, and an empty turn id is none", () => {
    expect(controlTarget({})).toBeNull();
    expect(controlTarget({ turnId: "", asks: [] })).toBeNull();
  });
});

describe("when the steer switch and Stop show", () => {
  it("steer only while working", () => {
    expect(steerOffered("working")).toBe(true);
    for (const status of ["idle", "blocked", "done", "unknown", undefined] as const) {
      expect(steerOffered(status)).toBe(false);
    }
  });

  it("stop while a turn runs or waits on a person, and only with something to name", () => {
    const target = { turnId: "t1" };
    expect(stopOffered("working", target)).toBe(true);
    expect(stopOffered("blocked", target)).toBe(true);
    expect(stopOffered("idle", target)).toBe(false);
    expect(stopOffered("working", null)).toBe(false);
  });
});

describe("one request id per intent", () => {
  let n = 0;
  const mint = () => `id-${++n}`;

  it("a retry of the same intent reuses the id", () => {
    const key = intentKey("hi", false, { turnId: "t1" });
    const first = requestIdFor(null, key, mint);
    expect(requestIdFor(first, key, mint)).toBe(first);
  });

  it("a changed text, switch or name mints a new one", () => {
    const first = requestIdFor(null, intentKey("hi", false, { turnId: "t1" }), mint);
    for (const key of [
      intentKey("hello", false, { turnId: "t1" }),
      intentKey("hi", true, { turnId: "t1" }),
      intentKey("hi", false, { turnId: "t2" }),
      intentKey("hi", false, { askId: "a1" }),
    ]) {
      expect(requestIdFor(first, key, mint).requestId).not.toBe(first.requestId);
    }
  });
});

describe("what an answer does to the composer", () => {
  it("ok clears the draft and reads the pane", () => {
    expect(readControl({ outcome: "ok" })).toMatchObject({ clear: true, keepId: false, reload: true, note: "sent" });
  });

  it("stale keeps the draft, reloads the pane and says the turn moved", () => {
    expect(readControl({ outcome: "stale", turnId: "t2", askIds: [] })).toMatchObject({
      clear: false,
      keepId: false,
      reload: true,
      note: "moved",
    });
  });

  it("stale from an old machine says so and has nothing to reload", () => {
    expect(readControl({ outcome: "stale", askIds: [], older: true })).toMatchObject({ clear: false, reload: false, note: "older" });
  });

  it("unknown keeps the draft and the id, for a retry", () => {
    expect(readControl({ outcome: "unknown" })).toMatchObject({ clear: false, keepId: true, note: "unknown" });
  });

  it("maybe-applied keeps the draft, drops the id, reads the pane and says to check the chat", () => {
    const reading = readControl({ outcome: "maybe-applied" });
    expect(reading).toMatchObject({ clear: false, keepId: false, reload: true, note: "maybe", detail: "" });
    expect(t(noteKey(reading, "send"))).toBe("May already be sent. Check the chat before you send again.");
    expect(t(noteKey(reading, "stop"))).toBe("The stop may already be applied. Check the chat.");
  });

  it("refused keeps the draft and carries the bridge's words", () => {
    expect(readControl({ outcome: "refused", reason: "refused", detail: "No turn named." })).toMatchObject({
      clear: false,
      keepId: false,
      note: "refused",
      detail: "No turn named.",
    });
  });

  it("a transport error is unknown, except a refusal the bridge made on purpose", () => {
    expect(readThrown(undefined, "network").note).toBe("unknown");
    expect(readThrown(503, "not ready").note).toBe("unknown");
    expect(readThrown(403, "not paired")).toMatchObject({ note: "refused", detail: "not paired", keepId: false });
  });

  it("every reading has a sentence in the catalog, for a send, a stop and a program action", () => {
    const results: ControlResult[] = [
      { outcome: "ok" },
      { outcome: "stale", askIds: [] },
      { outcome: "stale", askIds: [], older: true },
      { outcome: "unknown" },
      { outcome: "maybe-applied" },
      { outcome: "refused", reason: "refused", detail: "" },
      { outcome: "refused", reason: "request-id-reused", detail: "" },
    ];
    for (const result of results) {
      for (const kind of ["send", "stop", "action"] as const) {
        const key = noteKey(readControl(result), kind);
        expect(t(key)).not.toBe(key);
        expect(t(key)).not.toMatch(/\u2014/u);
      }
    }
  });
});
