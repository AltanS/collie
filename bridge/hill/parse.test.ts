import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { parseJsonObject, type JsonObject, type JsonValue } from "../../web/src/lib/json.ts";
import type { HillDecision } from "../../web/src/lib/hill/wire.ts";
import { decision } from "./fixtures.ts";
import { HILL_RAW_MAX, readAnswerRequest, readDecision, readPostFields } from "./parse.ts";
import { coerceHillReceipt, hillAnswerDigest, HILL_RECEIPTS_FILE, HillReceiptStore } from "./receipts.ts";
import { hillDir } from "./store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RID = "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f";

describe("a post's fields off the socket", () => {
  const base = { requestId: RID, title: "Ship?", summary: "Green." };

  test("the minimum reads with the defaults filled in; a `from` in the request is ignored", () => {
    const read = readPostFields({ ...base, from: { kind: "trick", trickId: "x" } });
    expect(read).toEqual({
      ok: true,
      input: { ...base, body: "", options: [], text: "optional", recommends: null, links: [], priority: "today", about: null, replyTo: null, supersedes: null, expiresAt: null, images: [] },
    });
  });

  test("a field of the wrong type is refused with the code of its field", () => {
    const code = (over: JsonObject) => {
      const read = readPostFields({ ...base, ...over });
      return read.ok ? "ok" : read.code;
    };
    expect(code({ title: 7 })).toBe("bad_title");
    expect(code({ summary: null })).toBe("bad_summary");
    expect(code({ body: ["x"] })).toBe("bad_body");
    expect(code({ options: "yes" })).toBe("bad_option");
    expect(code({ options: [{ intent: "yes" }] })).toBe("bad_option");
    expect(code({ text: "maybe" })).toBe("bad_text_mode");
    expect(code({ recommends: { intent: "yes" } })).toBe("bad_recommends");
    expect(code({ links: [{ label: "x" }] })).toBe("bad_link");
    expect(code({ replyTo: 5 })).toBe("bad_target");
    expect(code({ supersedes: "wt_aaaaaaaaaaa1" })).toBe("bad_supersedes");
    expect(code({ title: "t".repeat(HILL_RAW_MAX + 1) })).toBe("bad_title");
  });

  test("a request id, a priority or an expiry of the wrong shape is a bad request with no code", () => {
    expect(readPostFields({ ...base, requestId: "nope" })).toEqual({ ok: false, code: null, error: "bad request: a decision's request id is a UUID" });
    expect(readPostFields({ ...base, priority: "urgent" })).toMatchObject({ ok: false, code: null });
    expect(readPostFields({ ...base, expiresAt: "tomorrow" })).toMatchObject({ ok: false, code: null });
    expect(readPostFields({ ...base, expiresAt: 1.5 })).toMatchObject({ ok: false, code: null });
  });
});

describe("a phone's answer body", () => {
  test("reads rid, node, intent and text; the decision id comes from the node", () => {
    expect(readAnswerRequest({ rid: RID, node: "hill/dc_k3m9x2p7q1ab", intent: "yes", value: { text: "go" } })).toEqual({
      ok: true,
      id: "dc_k3m9x2p7q1ab",
      request: { rid: RID, node: "hill/dc_k3m9x2p7q1ab", intent: "yes", value: { text: "go" } },
    });
    expect(readAnswerRequest({ rid: RID, node: "hill/dc_k3m9x2p7q1ab", intent: "dismiss", value: { text: null } })).toMatchObject({ ok: true });
  });

  test("any other shape is refused, so the route answers 400 and writes no receipt", () => {
    const ok = { rid: RID, node: "hill/dc_k3m9x2p7q1ab", intent: "yes", value: { text: null } };
    expect(readAnswerRequest(undefined)).toEqual({ ok: false, error: "bad body" });
    expect(readAnswerRequest([])).toEqual({ ok: false, error: "bad body" });
    expect(readAnswerRequest({ ...ok, rid: "x" })).toEqual({ ok: false, error: "bad rid" });
    expect(readAnswerRequest({ ...ok, node: "dc_k3m9x2p7q1ab" })).toEqual({ ok: false, error: "bad node" });
    expect(readAnswerRequest({ ...ok, node: "hill/../../etc" })).toEqual({ ok: false, error: "bad node" });
    expect(readAnswerRequest({ ...ok, intent: "" })).toEqual({ ok: false, error: "bad intent" });
    expect(readAnswerRequest({ ...ok, intent: "i".repeat(33) })).toEqual({ ok: false, error: "bad intent" });
    expect(readAnswerRequest({ ...ok, value: "go" })).toEqual({ ok: false, error: "bad value" });
    expect(readAnswerRequest({ ...ok, value: { text: 5 } })).toEqual({ ok: false, error: "bad value" });
    expect(readAnswerRequest({ ...ok, value: { text: "x".repeat(HILL_RAW_MAX + 1) } })).toEqual({ ok: false, error: "bad value" });
  });
});

/** A decision as the file would hold it, through JSON and back, with `over` written on top. */
function onDisk(whole: HillDecision, over: JsonObject = {}): JsonValue | undefined {
  const row = parseJsonObject(JSON.stringify(whole));
  return row === null ? undefined : { ...row, ...over };
}

describe("a stored decision", () => {
  test("a whole decision reads back as itself", () => {
    const whole = decision("dc_aaaaaaaaaaa1", {
      recommends: { intent: "yes", why: "w" },
      links: [{ label: "L", href: "https://example.com" }],
      state: "answered",
      closedAt: 5,
      answer: { rid: RID, intent: "yes", label: "Yes", text: null, by: "Pixel", at: 5, delivery: "typed" },
    });
    expect(readDecision(onDisk(whole))).toEqual(whole);
  });

  test("a field that fails its rule fails the record", () => {
    const whole = decision("dc_aaaaaaaaaaa1");
    expect(readDecision(onDisk(whole, { v: 2 }))).toBeNull();
    expect(readDecision(onDisk(whole, { id: "dc_x" }))).toBeNull();
    expect(readDecision(onDisk(whole, { state: "maybe" }))).toBeNull();
    expect(readDecision(onDisk(whole, { priority: "soon" }))).toBeNull();
    expect(readDecision(onDisk(whole, { options: [{ intent: 1 }] }))).toBeNull();
    expect(readDecision(null)).toBeNull();
  });
});

describe("the receipt file", () => {
  test.skipIf(HOST.platform === "win32")("a record reaches <stateDir>/hill/receipts.json, owner-only, and a new store reads it back", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hill-receipts-"));
    roots.push(stateDir);
    const store = new HillReceiptStore(stateDir);
    await store.load();
    const record = { requestId: RID, payloadDigest: hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", null), receipt: { rid: RID, code: "ok" as const, reason: null, state: "answered" as const, delivery: "typed" as const, at: 5 } };
    expect(await store.recordFirst(record)).toBe(true);
    const path = join(hillDir(stateDir), HILL_RECEIPTS_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("typed words");
    const again = new HillReceiptStore(stateDir);
    await again.load();
    expect(again.get(RID)).toEqual(record);
  });

  test("the digest covers node, intent and text; a record whose rid is not its key is dropped", () => {
    expect(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", null)).toBe(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", ""));
    expect(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", "a")).not.toBe(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", "b"));
    expect(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", null)).not.toBe(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "no", null));
    const receipt = { rid: RID, code: "ok", reason: null, state: "answered", delivery: "typed", at: 5 };
    expect(coerceHillReceipt({ requestId: RID, payloadDigest: "d", receipt })).not.toBeNull();
    expect(coerceHillReceipt({ requestId: RID, payloadDigest: "d", receipt: { ...receipt, rid: "00000000-0000-4000-8000-000000000000" } })).toBeNull();
    expect(coerceHillReceipt({ requestId: RID, payloadDigest: "d", receipt: { ...receipt, code: "fine" } })).toBeNull();
  });
});
