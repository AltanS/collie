import { describe, expect, test } from "bun:test";

import { mintIdentity } from "./identity.ts";
import {
  bodyDigest,
  canonicalRequest,
  parseTimestamp,
  signRequest,
  timestampVerdict,
  verifyRequestSignature,
  MAX_SKEW_MS,
} from "./signing.ts";

const desk = mintIdentity({ commonName: "collie-desk" });
const laptop = mintIdentity({ commonName: "collie-laptop" });

const parts = { method: "POST", path: "/pack/v1/leave", body: "{}", timestamp: 1_786_000_000_000 };

describe("the canonical string", () => {
  test("is the four fields §8.6 names, in order, newline-separated", () => {
    expect(canonicalRequest("POST", "/pack/v1/leave", "abc", 17)).toBe("POST\n/pack/v1/leave\nabc\n17");
  });

  test("upper-cases the method, so a lower-case verb is not a second signature space", () => {
    expect(canonicalRequest("post", "/p", "d", 1)).toBe(canonicalRequest("POST", "/p", "d", 1));
  });

  test("an empty body hashes the empty string rather than a sentinel", () => {
    expect(bodyDigest("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("signing and verifying", () => {
  test("a member's own key verifies against its own certificate", () => {
    const signature = signRequest(desk.keyPem, parts);
    expect(verifyRequestSignature(desk.certPem, signature, parts)).toBe(true);
  });

  test("another member's certificate does not verify it — this is the whole point", () => {
    const signature = signRequest(desk.keyPem, parts);
    expect(verifyRequestSignature(laptop.certPem, signature, parts)).toBe(false);
  });

  test("every signed field is load-bearing: change any one and it stops verifying", () => {
    const signature = signRequest(desk.keyPem, parts);
    for (const mutated of [
      { ...parts, method: "GET" },
      { ...parts, path: "/pack/v1/lead" },
      { ...parts, body: '{"lead":"me"}' },
      { ...parts, timestamp: parts.timestamp + 1 },
    ]) {
      expect(verifyRequestSignature(desk.certPem, signature, mutated)).toBe(false);
    }
  });

  test("a malformed signature or certificate is `false`, never a throw", () => {
    expect(verifyRequestSignature(desk.certPem, "", parts)).toBe(false);
    expect(verifyRequestSignature(desk.certPem, "not base64 !!", parts)).toBe(false);
    expect(verifyRequestSignature("not a certificate", signRequest(desk.keyPem, parts), parts)).toBe(false);
  });

  test("ECDSA is randomised, so two signatures of the same request differ and both verify", () => {
    const a = signRequest(desk.keyPem, parts);
    const b = signRequest(desk.keyPem, parts);
    expect(a).not.toBe(b);
    expect(verifyRequestSignature(desk.certPem, a, parts)).toBe(true);
    expect(verifyRequestSignature(desk.certPem, b, parts)).toBe(true);
  });
});

describe("the timestamp header", () => {
  test("only a plain non-negative integer parses", () => {
    expect(parseTimestamp("1786000000000")).toBe(1_786_000_000_000);
    expect(parseTimestamp(" 17 ")).toBe(17);
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("-1")).toBeNull();
    expect(parseTimestamp("1.5")).toBeNull();
    expect(parseTimestamp("1e12")).toBeNull();
    expect(parseTimestamp("9".repeat(16))).toBeNull();
  });
});

describe("freshness and replay", () => {
  const now = 1_786_000_000_000;

  test("a fresh, strictly-newer timestamp is admitted", () => {
    expect(timestampVerdict(now, now, 0)).toBe("ok");
    expect(timestampVerdict(now, now, now - 1)).toBe("ok");
  });

  test("skew is refused in BOTH directions — a future stamp is how a capture is parked", () => {
    expect(timestampVerdict(now - MAX_SKEW_MS - 1, now, 0)).toBe("skew");
    expect(timestampVerdict(now + MAX_SKEW_MS + 1, now, 0)).toBe("skew");
    expect(timestampVerdict(now - MAX_SKEW_MS, now, 0)).toBe("ok");
    expect(timestampVerdict(now + MAX_SKEW_MS, now, 0)).toBe("ok");
  });

  test("replay is refused on equality, not only on going backwards", () => {
    expect(timestampVerdict(now, now, now)).toBe("replay");
    expect(timestampVerdict(now - 1, now, now)).toBe("replay");
  });

  test("skew is decided before replay, so a stale capture never touches the floor", () => {
    // A captured request replayed long after the fact is `skew`, and the caller records nothing —
    // which matters, because recording it would advance the floor past every legitimate request
    // still in flight.
    expect(timestampVerdict(now - MAX_SKEW_MS - 1, now, now - MAX_SKEW_MS - 2)).toBe("skew");
  });
});
