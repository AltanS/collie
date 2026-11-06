import { describe, expect, test } from "bun:test";

import type { AuditEntry } from "../audit.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import { pinsRoute, type PinsDeps, type PinsRequest, type PinsSession } from "./routes.ts";
import { MAX_PINS, PinStore } from "./store.ts";

const ENTRIES: TranscriptEntry[] = [
  { uuid: "u1", ts: "2026-11-06T10:00:00Z", role: "user", parts: [{ kind: "text", text: "token sk-or-v1-0123456789abcdef0123456789abcdef is mine" }] },
  {
    uuid: "a1",
    ts: "",
    role: "assistant",
    parts: [
      { kind: "text", text: "done" },
      { kind: "tool", name: "Bash", summary: "bun test", id: "toolu_1", result: { text: "12 pass" } },
      { kind: "image", url: "/api/blobs/x" },
    ],
  },
  { uuid: "s1", ts: "", role: "summary", parts: [{ kind: "text", text: "recap" }] },
];

function rig(over: Partial<PinsDeps> = {}, entries: (() => Promise<readonly TranscriptEntry[] | null>) | null = async () => ENTRIES) {
  const audit: AuditEntry[] = [];
  const store = new PinStore(null, () => 1_786_000_000_000, (() => {
    let n = 0;
    return () => `p${++n}`;
  })());
  const journal: PinsSession | null = entries === null ? null : { key: "claude.s1", entries };
  const deps: PinsDeps = { store, journal, redact: false, audit: { record: (entry) => void audit.push(entry) }, device: "pixel", session: "default", paneId: "w1:p1", ...over };
  const call = (req: Partial<PinsRequest> & { method: string }) => pinsRoute(deps, { pin: null, body: undefined, ...req });
  return { audit, store, deps, call };
}

describe("POST /pins", () => {
  test("pins a block from the journal's own copy and audits it without the text", async () => {
    const { call, audit, store } = rig();
    const answer = await call({ method: "POST", body: { itemId: "u1:0", text: "forged by the phone" } });
    expect(answer).toMatchObject({ status: 201, body: { pin: { id: "p1", itemId: "u1:0", kind: "user", ts: "2026-11-06T10:00:00Z" } } });
    expect(store.list("claude.s1")[0]!.text).toContain("is mine");
    expect(store.list("claude.s1")[0]!.text).not.toContain("forged");
    expect(audit).toEqual([{ action: "pin.add", session: "default", paneId: "w1:p1", device: "pixel", detail: { pin: "p1", kind: "user" } }]);
  });

  test("pins a tool call by its own id with name, input and result", async () => {
    const { call } = rig();
    expect(await call({ method: "POST", body: { itemId: "toolu_1" } })).toMatchObject({
      status: 201,
      body: { pin: { kind: "tool", text: "12 pass", tool: { name: "Bash", input: "bun test" } } },
    });
  });

  test("a block that is already pinned answers 200 with its pin and writes no second audit line", async () => {
    const { call, audit } = rig();
    await call({ method: "POST", body: { itemId: "u1:0" } });
    expect(await call({ method: "POST", body: { itemId: "u1:0" } })).toMatchObject({ status: 200, body: { pin: { id: "p1" } } });
    expect(audit).toHaveLength(1);
  });

  test("404 pin.item_not_found for an id the log does not hold, and when the log cannot be read", async () => {
    const { call, audit } = rig();
    expect(await call({ method: "POST", body: { itemId: "gone:0" } })).toMatchObject({ status: 404, body: { code: "pin.item_not_found" } });
    const unreadable = rig({}, async () => null);
    expect(await unreadable.call({ method: "POST", body: { itemId: "u1:0" } })).toMatchObject({ status: 404, body: { code: "pin.item_not_found" } });
    expect([...audit, ...unreadable.audit]).toEqual([]);
  });

  test("409 pin.not_pinnable for an image and a compaction marker", async () => {
    const { call } = rig();
    expect(await call({ method: "POST", body: { itemId: "a1:2" } })).toMatchObject({ status: 409, body: { code: "pin.not_pinnable" } });
    expect(await call({ method: "POST", body: { itemId: "s1:0" } })).toMatchObject({ status: 409, body: { code: "pin.not_pinnable" } });
  });

  test("409 pin.cap on the 101st pin, and an error body carries a sentence beside its code", async () => {
    const { call, store, audit } = rig();
    for (let i = 0; i < MAX_PINS; i += 1) store.add("claude.s1", { itemId: `e${i}:0`, kind: "reply", text: "t" });
    const answer = await call({ method: "POST", body: { itemId: "u1:0" } });
    expect(answer).toEqual({ status: 409, body: { error: `a session keeps at most ${MAX_PINS} pins; unpin one first`, code: "pin.cap" } });
    expect(audit).toEqual([]);
  });

  test("409 pin.no_session on a pane with no journal session, for every method", async () => {
    const { call } = rig({}, null);
    for (const method of ["GET", "POST", "DELETE"]) {
      expect(await call({ method, body: { itemId: "u1:0" }, pin: "p1" })).toMatchObject({ status: 409, body: { code: "pin.no_session" } });
    }
  });

  test("400 for a body with no item id, an empty one, or one past the cap, and 500 when the write fails", async () => {
    const { call } = rig();
    for (const body of [undefined, {}, { itemId: 7 }, { itemId: "" }, { itemId: "x".repeat(301) }, "u1:0"]) {
      expect(await call({ method: "POST", body })).toEqual({ status: 400, text: "bad body" });
    }
    const failing = rig();
    failing.store.add = () => ({ ok: false, reason: "write" });
    expect(await failing.call({ method: "POST", body: { itemId: "u1:0" } })).toEqual({ status: 500, text: "could not keep the pin" });
    expect(failing.audit).toEqual([]);
  });
});

describe("GET /pins", () => {
  test("lists newest first, and masks the text that leaves when redaction is on", async () => {
    const plain = rig();
    await plain.call({ method: "POST", body: { itemId: "u1:0" } });
    await plain.call({ method: "POST", body: { itemId: "toolu_1" } });
    const listed = await plain.call({ method: "GET" });
    expect(listed.status).toBe(200);
    expect("body" in listed && "pins" in listed.body && listed.body.pins.map((pin) => pin.itemId)).toEqual(["toolu_1", "u1:0"]);
    expect(JSON.stringify(listed)).toContain("sk-or-v1-0123456789abcdef0123456789abcdef");

    const masked = rig({ redact: true });
    await masked.call({ method: "POST", body: { itemId: "u1:0" } });
    expect(JSON.stringify(await masked.call({ method: "GET" }))).not.toContain("0123456789abcdef0123456789abcdef");
    // The file keeps the copy the log held.
    expect(masked.store.list("claude.s1")[0]!.text).toContain("0123456789abcdef0123456789abcdef");
  });

  test("an empty session answers an empty list", async () => {
    expect(await rig().call({ method: "GET" })).toEqual({ status: 200, body: { pins: [] } });
  });
});

describe("DELETE /pins", () => {
  test("drops the pin, audits it once, and answers 204 again when it is already gone", async () => {
    const { call, audit, store } = rig();
    await call({ method: "POST", body: { itemId: "u1:0" } });
    expect(await call({ method: "DELETE", pin: "p1" })).toEqual({ status: 204 });
    expect(await call({ method: "DELETE", pin: "p1" })).toEqual({ status: 204 });
    expect(store.count("claude.s1")).toBe(0);
    expect(audit.map((entry) => entry.action)).toEqual(["pin.add", "pin.remove"]);
    expect(audit[1]).toEqual({ action: "pin.remove", session: "default", paneId: "w1:p1", device: "pixel", detail: { pin: "p1" } });
  });

  test("400 without a pin id, and 500 when the write fails", async () => {
    const { call, store } = rig();
    expect(await call({ method: "DELETE" })).toEqual({ status: 400, text: "bad pin" });
    expect(await call({ method: "DELETE", pin: "" })).toEqual({ status: 400, text: "bad pin" });
    store.remove = () => ({ ok: false, reason: "write" });
    expect(await call({ method: "DELETE", pin: "p1" })).toEqual({ status: 500, text: "could not drop the pin" });
  });
});

test("another method is 405", async () => {
  expect(await rig().call({ method: "PUT" })).toEqual({ status: 405, text: "method not allowed" });
});
