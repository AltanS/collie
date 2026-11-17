import { describe, expect, test } from "bun:test";

import { INSTANCE_TOKEN } from "../walky/address.ts";
import { decodeSessionId, encodeSessionId, SESSION_ID_MAX, type SessionIdParts } from "./session-id.ts";

const PARTS: SessionIdParts = { machine: "m_k3x9q2w7ab", paneId: "w1:p1", instance: "k3f9" };

function wrap(inside: string): string {
  return `ses_${Buffer.from(inside, "utf8").toString("base64url")}`;
}

describe("session id", () => {
  test("round trips", () => {
    const id = encodeSessionId(PARTS);
    expect(id.startsWith("ses_")).toBe(true);
    expect(decodeSessionId(id)).toEqual(PARTS);
  });

  test("a | and a / in a part survive and cannot shift the fields", () => {
    const parts = { machine: "lead-1", paneId: "a|b/c|%7", instance: "zz00" };
    expect(decodeSessionId(encodeSessionId(parts))).toEqual(parts);
  });

  test("no mux session name rides inside: four fields, as a WalkyTalky address", () => {
    expect(Buffer.from(encodeSessionId(PARTS).slice(4), "base64url").toString("utf8")).toBe("1|m_k3x9q2w7ab|w1%3Ap1|k3f9");
  });

  test("a new instance token makes a new id for the same pane", () => {
    expect(encodeSessionId(PARTS)).not.toBe(encodeSessionId({ ...PARTS, instance: "aaaa" }));
  });

  test("the instance shape agrees with walky's token", () => {
    expect(INSTANCE_TOKEN.test(PARTS.instance)).toBe(true);
    expect(() => encodeSessionId({ ...PARTS, instance: "K3F9" })).toThrow();
    expect(() => encodeSessionId({ ...PARTS, instance: "k3f" })).toThrow();
    expect(() => encodeSessionId({ ...PARTS, paneId: "" })).toThrow();
  });

  test("an id past the bound is not written", () => {
    expect(() => encodeSessionId({ ...PARTS, paneId: "x".repeat(SESSION_ID_MAX) })).toThrow();
  });

  test.each([
    ["empty", ""],
    ["no prefix", Buffer.from("1|m|p|k3f9").toString("base64url")],
    ["bad base64", "ses_!!!!"],
    ["padding", `${wrap("1|m|p|k3f9")}=`],
    ["wrong version", wrap("2|m|p|k3f9")],
    ["too few fields", wrap("1|m|k3f9")],
    ["too many fields", wrap("1|m|s|p|k3f9")],
    ["a raw | split", wrap("1|m|a|b|k3f9")],
    ["an empty part", wrap("1|m||k3f9")],
    ["a bad token", wrap("1|m|p|K3F9")],
    ["a broken escape", wrap("1|m|%E0%A4|k3f9")],
    ["a needless escape", wrap("1|m|%73|k3f9")],
    ["a raw / the encoder escapes", wrap("1|m|a/b|k3f9")],
    ["too long", `ses_${"A".repeat(SESSION_ID_MAX)}`],
    ["bytes that are not utf-8", `ses_${Buffer.from([0x31, 0x7c, 0xff, 0x7c, 0x70, 0x7c, 0x6b, 0x33, 0x66, 0x39]).toString("base64url")}`],
  ])("refuses %s", (_name, text) => {
    expect(decodeSessionId(text)).toBeNull();
  });

  test("another base64 spelling of the same bytes is refused", () => {
    // Thirteen bytes: the last base64 character carries two bits and four unused ones.
    const id = wrap("1|mmm|pp|k3f9");
    expect(decodeSessionId(id)).toEqual({ machine: "mmm", paneId: "pp", instance: "k3f9" });
    const body = id.slice(4);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const twin = `ses_${body.slice(0, -1)}${alphabet[alphabet.indexOf(body.at(-1)!) ^ 1]!}`;
    expect(Buffer.from(twin.slice(4), "base64url").equals(Buffer.from(body, "base64url"))).toBe(true);
    expect(decodeSessionId(twin)).toBeNull();
  });
});
