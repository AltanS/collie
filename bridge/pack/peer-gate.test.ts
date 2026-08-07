import { describe, expect, test } from "bun:test";

import { packDeviceOf, packGate, type PeerGateConfig } from "./peer-gate.ts";

// §12: "A peer is never asked to trust the lead's authorisation decision in place of its own."
//
// Every test here is a variation on one sentence: the verdict is a function of the PEER's config and
// the device the link carried — never of anything the lead decided. There is deliberately no input
// to `packGate` that could carry a lead's verdict, which is the strongest form the rule can take.

const OFF: PeerGateConfig = { deviceHeader: "", deviceAllowlist: [] };
const ON: PeerGateConfig = { deviceHeader: "x-tailnet-device", deviceAllowlist: ["phone-7", "tablet-2"] };

describe("the peer applies its OWN write-level checks (§12)", () => {
  test("a device the LEAD trusts and the PEER does not cannot write on the peer", () => {
    // The lead necessarily authorised this write — it forwarded it. That is not an input here.
    const verdict = packGate("write", ON, "someone-elses-phone");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("not authorised on this host");
  });

  test("a device on the peer's own allowlist writes", () => {
    expect(packGate("write", ON, "phone-7")).toEqual({ ok: true });
    expect(packGate("write", ON, "tablet-2")).toEqual({ ok: true });
  });

  test("the gate being OFF on the peer means today's behaviour for its own operator", () => {
    // Enrolling in a pack must not silently switch on a gate nobody configured.
    expect(packGate("write", OFF, null)).toEqual({ ok: true });
    expect(packGate("write", OFF, "anything")).toEqual({ ok: true });
  });

  test("a gated peer refuses a write that names no device", () => {
    // The lead omits the header when ITS gate is off; a peer that turned the gate on asked for every
    // write to name a device, and fail-closed is the point of turning it on.
    const verdict = packGate("write", ON, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("named no device");
  });

  test('the "unknown" sentinel is never authorised, even if somebody allowlists it', () => {
    expect(packGate("write", { deviceHeader: "h", deviceAllowlist: ["unknown"] }, "unknown").ok).toBe(false);
  });

  test("an empty allowlist on a gated peer makes every pack write read-only", () => {
    expect(packGate("write", { deviceHeader: "h", deviceAllowlist: [] }, "phone-7").ok).toBe(false);
  });

  test("reads are always admitted — the link's two factors already did that work", () => {
    for (const device of [null, "phone-7", "someone-elses-phone", "unknown"]) {
      expect(packGate("read", ON, device)).toEqual({ ok: true });
      expect(packGate("read", OFF, device)).toEqual({ ok: true });
    }
  });
});

describe("the device identity comes off the LINK, not off the peer's own header", () => {
  const req = (headers: Record<string, string>) => new Request("https://peer.example/api/pane/x", { headers });

  test("X-Pack-Device is read, and read even when the peer's device feature is off", () => {
    // Attribution and authorisation are different questions: a peer with no device gate still wants
    // the operator's identity in its audit line (§12).
    expect(packDeviceOf(req({ "x-pack-device": "phone-7" }))).toBe("phone-7");
    expect(packDeviceOf(req({ "x-pack-device": "  phone-7  " }))).toBe("phone-7");
  });

  test("a peer's own COLLIE_DEVICE_HEADER value is NOT an input — only the pack header is", () => {
    // Anything a fronting proxy injected is about a browser at the peer's own door, not about the
    // operator on the other side of a lead. Reading it here would be a second, unaudited basis.
    expect(packDeviceOf(req({ "x-tailnet-device": "phone-7" }))).toBeNull();
  });

  test("absent and blank are the same thing", () => {
    expect(packDeviceOf(req({}))).toBeNull();
    expect(packDeviceOf(req({ "x-pack-device": "   " }))).toBeNull();
  });
});
