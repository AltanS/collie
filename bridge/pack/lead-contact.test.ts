import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { T0 } from "./fixtures.ts";
import { everDialled, LeadContact, silentForMs } from "./lead-contact.ts";

// Gap A (§18.9): a peer knows when its lead last called it. One number, in memory, on this collie's
// own clock — and the same number the deputy's door arms on, so there is nothing here to disagree
// with `pack status`.

describe("the lead's receipt (§18.9)", () => {
  test("a fresh process has been dialled by nobody, and says so", () => {
    const contact = new LeadContact(T0);
    expect(contact.facts()).toEqual({ processStartedAt: T0, lastDialledAt: null, leadRefusedSecretAt: null });
    expect(everDialled(contact.facts())).toBe(false);
  });

  test("every landed call is a receipt, and the newest one stands", () => {
    const contact = new LeadContact(T0);
    contact.record(T0 + 1_000);
    contact.record(T0 + 4_000);
    expect(contact.facts().lastDialledAt).toBe(T0 + 4_000);
    expect(everDialled(contact.facts())).toBe(true);
  });

  test("a receipt never moves BACKWARDS — a stepped clock cannot make a link look quieter", () => {
    const contact = new LeadContact(T0);
    contact.record(T0 + 4_000);
    contact.record(T0 + 1_000);
    expect(contact.facts().lastDialledAt).toBe(T0 + 4_000);
    contact.recordSecretRefusal(T0 + 9_000);
    contact.recordSecretRefusal(T0 + 2_000);
    expect(contact.facts().leadRefusedSecretAt).toBe(T0 + 9_000);
  });

  test("silence is measured from the LATER of the last dial and this process's start", () => {
    // A collie that has just restarted has never been dialled by anybody. Without the boot term it
    // would read as maximally silent from its first instant, and a door reading this would arm on
    // every reboot (RFC §6.3). Including it gives the lead one full window to make its first call.
    const fresh = new LeadContact(T0);
    expect(silentForMs(fresh.facts(), T0 + 12_000)).toBe(12_000);

    fresh.record(T0 + 10_000);
    expect(silentForMs(fresh.facts(), T0 + 12_000)).toBe(2_000);

    // A receipt from before this process started is not a fact about this process.
    const restarted = new LeadContact(T0 + 50_000);
    restarted.record(T0 + 10_000);
    expect(silentForMs(restarted.facts(), T0 + 51_000)).toBe(1_000);
  });

  test("a clock that ran backwards yields zero silence, never a negative one", () => {
    const contact = new LeadContact(T0);
    contact.record(T0 + 5_000);
    expect(silentForMs(contact.facts(), T0 + 1_000)).toBe(0);
  });

  test("a refusal on the SECRET is recorded separately — it is not a dial and not silence", () => {
    // §8.4's rotation, seen from the side that was dropped: the lead is calling and this machine no
    // longer holds the pack secret. Conflating it with a receipt would make a stranded machine look
    // healthy; conflating it with silence would make it look unreachable. It is neither.
    const contact = new LeadContact(T0);
    contact.recordSecretRefusal(T0 + 3_000);
    expect(contact.facts().lastDialledAt).toBeNull();
    expect(silentForMs(contact.facts(), T0 + 6_000)).toBe(6_000);
    expect(contact.facts().leadRefusedSecretAt).toBe(T0 + 3_000);
  });

  test("nothing here is persisted — it describes a PROCESS", () => {
    // A persisted receipt would survive the restart it is meant to report and would then state a
    // falsehood with the authority of the trust store (§7.1's rule for exactly this shape). The claim
    // is structural: this module touches no disk, so there is nothing that could outlive the process.
    const src = readFileSync(join(import.meta.dir, "lead-contact.ts"), "utf8");
    expect(src).not.toMatch(/node:fs|writeFile|TrustStore/);
  });
});
