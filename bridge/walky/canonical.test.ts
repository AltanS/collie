import { describe, expect, test } from "bun:test";

import { fingerprintOfCert, mintIdentity } from "../crew/identity.ts";
import { signCanonical, verifyCanonical } from "../crew/signing.ts";
import { attestationString, canonicalMessage, signMessage, verifyMessage, voucherString } from "./canonical.ts";
import type { WalkyMessage } from "./types.ts";

const desk = mintIdentity({ commonName: "collie-desk" });
const laptop = mintIdentity({ commonName: "collie-laptop" });

const message: WalkyMessage = {
  v: 1,
  id: "wt_k3f9x2m8q1a0",
  kind: "operator",
  from: { memberId: null, address: null, harness: null, label: "cli" },
  to: "local/w1:p2",
  replyTo: null,
  at: 1_786_000_000_000,
  body: "hello",
  signer: null,
  signature: null,
};

describe("the canonical string", () => {
  test("is the domain tag and nine fields, with a dash for every null", () => {
    expect(canonicalMessage(message)).toBe(
      [
        "collie-walky-v1",
        "wt_k3f9x2m8q1a0",
        "operator",
        "-",
        "-",
        "-",
        "local/w1:p2",
        "-",
        "1786000000000",
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      ].join("\n"),
    );
  });

  test("leaves the label out and keeps `to` in", () => {
    expect(canonicalMessage({ ...message, from: { ...message.from, label: "other" } })).toBe(canonicalMessage(message));
    expect(canonicalMessage({ ...message, to: "local/w1:p3" })).not.toBe(canonicalMessage(message));
  });
});

describe("signing", () => {
  test("a signed message verifies against the signer's certificate only", () => {
    const signed = signMessage(message, desk.keyPem, "desk");
    expect(signed.signer).toBe("desk");
    expect(verifyMessage(signed, desk.certPem)).toBe(true);
    expect(verifyMessage(signed, laptop.certPem)).toBe(false);
  });

  test("a re-aimed or edited message no longer verifies", () => {
    const signed = signMessage(message, desk.keyPem, "desk");
    expect(verifyMessage({ ...signed, to: "local/w9:p9" }, desk.certPem)).toBe(false);
    expect(verifyMessage({ ...signed, body: "hullo" }, desk.certPem)).toBe(false);
  });

  test("an unsigned message never verifies", () => {
    expect(verifyMessage(message, desk.certPem)).toBe(false);
  });
});

describe("the attestation string", () => {
  test("binds the id, the crew, the receiver and the message", () => {
    const one = attestationString(message, "crew-1", "laptop");
    expect(one.split("\n").slice(0, 4)).toEqual(["collie-walky-attest-v1", "wt_k3f9x2m8q1a0", "crew-1", "laptop"]);
    expect(attestationString(message, "crew-1", "desk")).not.toBe(one);
    expect(attestationString({ ...message, body: "x" }, "crew-1", "laptop")).not.toBe(one);
  });
});

describe("the voucher string (CREW_PROTOCOL §21, added 2026-10-18)", () => {
  test("is its own domain tag, the crew, the member and the certificate's fingerprint", () => {
    const fingerprint = fingerprintOfCert(laptop.certPem)!;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(voucherString("crew-1", "laptop", fingerprint)).toBe(["collie-walky-voucher-v1", "crew-1", "laptop", fingerprint].join("\n"));
  });

  test("a voucher for one crew, member or certificate is not good for another, and never as an attestation", () => {
    const fingerprint = fingerprintOfCert(laptop.certPem)!;
    const voucher = signCanonical(desk.keyPem, voucherString("crew-1", "laptop", fingerprint));
    expect(verifyCanonical(desk.certPem, voucher, voucherString("crew-1", "laptop", fingerprint))).toBe(true);
    expect(verifyCanonical(desk.certPem, voucher, voucherString("crew-2", "laptop", fingerprint))).toBe(false);
    expect(verifyCanonical(desk.certPem, voucher, voucherString("crew-1", "desk", fingerprint))).toBe(false);
    expect(verifyCanonical(desk.certPem, voucher, voucherString("crew-1", "laptop", fingerprintOfCert(desk.certPem)!))).toBe(false);
    expect(verifyCanonical(desk.certPem, voucher, attestationString(message, "crew-1", "laptop"))).toBe(false);
  });
});
