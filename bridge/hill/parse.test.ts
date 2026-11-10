import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { parseJson, parseJsonObject, type JsonObject, type JsonValue } from "../../web/src/lib/json.ts";
import type { HillDecision } from "../../web/src/lib/hill/wire.ts";
import type { View } from "../../web/src/lib/tricks/schema.ts";
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
describe("a post's view", () => {
  const base = { requestId: RID, title: "Ship?", summary: "Green." };
  const gate: View = [{ kind: "bar", kids: [{ kind: "chip", text: "unit", attrs: { tone: "ok" } }] }, { kind: "list", kids: [{ kind: "row", text: "legs", kids: [{ kind: "chip", text: "7/7" }] }] }];
  const refusal = (view: JsonValue) => {
    const read = readPostFields({ ...base, view });
    return read.ok ? "ok" : `${String(read.code)} ${read.error}`;
  };

  test("a display view reads onto the input; null or absent is no view", () => {
    const read = readPostFields({ ...base, view: parseJson(JSON.stringify(gate)) ?? null });
    expect(read.ok ? read.input.view : null).toEqual(gate);
    const none = readPostFields({ ...base, view: null });
    expect(none.ok && !("view" in none.input)).toBe(true);
  });

  test("a button, a card, an image or an intent is refused bad_body, the reason naming the path", () => {
    expect(refusal([{ kind: "button", text: "Merge", attrs: { intent: "merge" } }])).toStartWith("bad_body the view is refused at /view/0");
    expect(refusal([{ kind: "card", kids: [{ kind: "para", text: "x" }] }])).toStartWith("bad_body the view is refused at /view/0");
    expect(refusal([{ kind: "image", attrs: { src: "media/a.png" } }])).toStartWith("bad_body the view is refused at /view/0");
    expect(refusal([{ kind: "list", kids: [{ kind: "row", text: "x", attrs: { intent: "go" } }] }])).toStartWith("bad_body the view is refused at /view/0/kids/0/attrs/intent");
    expect(refusal("rows")).toStartWith("bad_body");
  });

  test("past 8 KiB, 100 nodes or depth 4 is refused", () => {
    expect(refusal([{ kind: "para", text: "x".repeat(9000) }])).toContain("bad_body");
    expect(refusal([{ kind: "list", kids: Array.from({ length: 120 }, () => ({ kind: "row", text: "x" })) }])).toContain("bad_body");
    expect(refusal([{ kind: "group", kids: [{ kind: "group", kids: [{ kind: "group", kids: [{ kind: "group", kids: [{ kind: "para", text: "deep" }] }] }] }] }])).toContain("bad_body");
  });
});

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
      answer: { rid: RID, intent: "yes", label: "Yes", text: null, by: "Pixel", at: 5, delivery: "typed", trick: "none" },
    });
    expect(readDecision(onDisk(whole))).toEqual(whole);
  });

  test("a trick's decision reads back only with its trick, its key and its routing member id", () => {
    const base = decision("dc_aaaaaaaaaaa1");
    const trick = { ...base, from: { ...base.from, kind: "trick" as const, address: null, trickId: "legs", trickKey: "k", memberId: "bluefin-hc", label: "Legs", host: "bluefin", trickHost: "bluefin-hc" } };
    expect(readDecision(onDisk(trick))).toEqual(trick);
    const row = { ...parseJsonObject(JSON.stringify(trick)) };
    const from = { ...parseJsonObject(JSON.stringify(trick.from)) };
    // Absent fields are not read as null any more: those formats never shipped.
    for (const key of ["trickHost", "trickKey"]) {
      const { [key]: _gone, ...without } = from;
      expect(readDecision({ ...row, from: without }), key).toBeNull();
    }
    // The dev lane stored trick decisions with `trickHost: null` and the routing value in `host`.
    expect(readDecision({ ...row, from: { ...from, trickHost: null, host: "bluefin-hc" } })).toBeNull();
    expect(readDecision({ ...row, from: { ...from, trickKey: null } })).toBeNull();
    expect(readDecision({ ...row, from: { ...from, trickHost: 5 } })).toBeNull();
    // An agent's decision has neither.
    expect(readDecision(onDisk(base))?.from).toMatchObject({ kind: "agent", trickKey: null, trickHost: null });
  });

  test("an answer without its trick delivery does not read: every answer since M94 stores one", () => {
    const answered = decision("dc_aaaaaaaaaaa1", { state: "answered", closedAt: 5, answer: { rid: RID, intent: "yes", label: "Yes", text: null, by: "Pixel", at: 5, delivery: "typed", trick: "none" } });
    const row = { ...parseJsonObject(JSON.stringify(answered)) };
    const { trick: _gone, ...bare } = { ...parseJsonObject(JSON.stringify(answered.answer)) };
    expect(readDecision({ ...row, answer: bare })).toBeNull();
  });

  test("an answer's device id reads back when present and stays absent when not; a bad one fails the record", () => {
    const answered = decision("dc_aaaaaaaaaaa1", { state: "answered", closedAt: 5, answer: { rid: RID, intent: "yes", label: "Yes", text: null, by: "Pixel", at: 5, delivery: "typed", trick: "none", deviceId: "dv_0123456789abcdef" } });
    expect(readDecision(onDisk(answered))).toEqual(answered);
    expect(readDecision(onDisk(answered, { answer: { ...answered.answer!, deviceId: "Pixel" } }))).toBeNull();
  });

  test("the post digest reads back when present and stays absent when not; a bad one fails the record", () => {
    const digest = "a".repeat(64);
    const withDigest = decision("dc_aaaaaaaaaaa1", { postDigest: digest });
    expect(readDecision(onDisk(withDigest))).toEqual(withDigest);
    expect(readDecision(onDisk(decision("dc_aaaaaaaaaaa1")))).not.toHaveProperty("postDigest");
    expect(readDecision(onDisk(withDigest, { postDigest: "short" }))).toBeNull();
    expect(readDecision(onDisk(withDigest, { postDigest: 7 }))).toBeNull();
  });

  test("a stored view reads back; a view that fails its rule is dropped and the decision stays", () => {
    const view: View = [{ kind: "para", text: "From the leg." }];
    const withView = decision("dc_aaaaaaaaaaa1", { view });
    expect(readDecision(onDisk(withView))).toEqual(withView);
    const bad = readDecision(onDisk(withView, { view: [{ kind: "button", text: "x", attrs: { intent: "go" } }] }));
    expect(bad?.id).toBe("dc_aaaaaaaaaaa1");
    expect(bad).not.toHaveProperty("view");
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
    const record = { requestId: RID, payloadDigest: hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", null), receipt: { rid: RID, code: "ok" as const, reason: null, state: "answered" as const, delivery: "typed" as const, trick: "none" as const, at: 5 } };
    expect(await store.recordFirst(record)).toBe(true);
    const path = join(hillDir(stateDir), HILL_RECEIPTS_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("typed words");
    const again = new HillReceiptStore(stateDir);
    await again.load();
    expect(again.get(RID)).toEqual(record);
    // A receipt with the device's record id reads back with it.
    const withDevice = { ...record, receipt: { ...record.receipt, deviceId: "dv_0123456789abcdef" } };
    expect(await again.recordFirst(withDevice)).toBe(true);
    const third = new HillReceiptStore(stateDir);
    await third.load();
    expect(third.get(RID)).toEqual(withDevice);
    expect(coerceHillReceipt({ ...withDevice, receipt: { ...withDevice.receipt, deviceId: 5 } })).toBeNull();
  });

  test("the digest covers node, intent and text; a record whose rid is not its key is dropped", () => {
    expect(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", null)).toBe(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", ""));
    expect(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", "a")).not.toBe(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", "b"));
    expect(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "yes", null)).not.toBe(hillAnswerDigest("hill/dc_aaaaaaaaaaa1", "no", null));
    const receipt = { rid: RID, code: "ok", reason: null, state: "answered", delivery: "typed", trick: "none", at: 5 };
    expect(coerceHillReceipt({ requestId: RID, payloadDigest: "d", receipt })).not.toBeNull();
    // Every receipt since M94 stores its trick delivery; one without it does not read (never shipped).
    const { trick: _gone, ...bare } = receipt;
    expect(coerceHillReceipt({ requestId: RID, payloadDigest: "d", receipt: bare })).toBeNull();
    expect(coerceHillReceipt({ requestId: RID, payloadDigest: "d", receipt: { ...receipt, trick: null, delivery: null } })).not.toBeNull();
    expect(coerceHillReceipt({ requestId: RID, payloadDigest: "d", receipt: { ...receipt, rid: "00000000-0000-4000-8000-000000000000" } })).toBeNull();
    expect(coerceHillReceipt({ requestId: RID, payloadDigest: "d", receipt: { ...receipt, code: "fine" } })).toBeNull();
  });
});
