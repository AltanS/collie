import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../json.ts";
import { readCrewDelivery, SENDER_CERT_MAX, SIGNATURE_MAX } from "./parse.ts";
import type { WalkyMessage } from "./types.ts";

// The crew readers added on 2026-10-18 (CREW_PROTOCOL §21): the delivery's optional sender block.
// Each is total over garbage.

const message: WalkyMessage = {
  v: 1,
  id: "wt_aaaaaaaaaaa1",
  kind: "agent",
  from: { memberId: "other", address: "other/w1:p1", harness: "claude", label: "repo#main" },
  to: "laptop/w1:p9",
  replyTo: null,
  at: 1_786_000_000_000,
  body: "hi",
  signer: "other",
  signature: "c2lnbmF0dXJl",
};

/** A value as it arrives off the wire. */
function wire<T>(value: T): JsonValue {
  // SAFETY: `JSON.parse` output IS a JsonValue by construction.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

describe("the delivery's sender block", () => {
  const block = { certPem: "-----BEGIN CERTIFICATE-----", voucher: "dm91Y2hlcg==" };

  test("absent or null is none; whole is read", () => {
    expect(readCrewDelivery(wire({ message, attest: "YQ==" }))).toEqual({ message, attest: "YQ==" });
    expect(readCrewDelivery(wire({ message, attest: "YQ==", sender: null }))).toEqual({ message, attest: "YQ==" });
    expect(readCrewDelivery(wire({ message, attest: "YQ==", sender: block }))).toEqual({ message, attest: "YQ==", sender: block });
  });

  test("past its caps, empty, half there or not an object is a malformed body", () => {
    expect(readCrewDelivery(wire({ message, attest: "YQ==", sender: { ...block, certPem: "x".repeat(SENDER_CERT_MAX) } }))).not.toBeNull();
    expect(readCrewDelivery(wire({ message, attest: "YQ==", sender: { ...block, voucher: "x".repeat(SIGNATURE_MAX) } }))).not.toBeNull();
    for (const sender of [
      { ...block, certPem: "x".repeat(SENDER_CERT_MAX + 1) },
      { ...block, voucher: "x".repeat(SIGNATURE_MAX + 1) },
      { ...block, certPem: "" },
      { certPem: block.certPem },
      { ...block, voucher: 7 },
      "yes",
      [block],
    ]) {
      expect(readCrewDelivery(wire({ message, attest: "YQ==", sender }))).toBeNull();
    }
    expect(SENDER_CERT_MAX).toBe(4096);
    expect(SIGNATURE_MAX).toBe(512);
  });
});
