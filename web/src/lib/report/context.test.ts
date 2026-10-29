import { describe, expect, it } from "vitest";

import { readReportContext } from "./context";

// What an older bridge answers: the setup half, no `doctor` field.
const OLD = { collie: "1.24.2", line: "stable", os: "linux", arch: "x64", mux: "herdr", harness: "claude", screenable: true };

describe("readReportContext: the doctor rows (M71 spec 05)", () => {
  it("leaves the field absent on an older bridge", () => {
    const context = readReportContext(OLD);
    expect(context).not.toBeNull();
    expect(context).not.toHaveProperty("doctor");
  });

  it("keeps good rows in the bridge's order and drops a bad one", () => {
    const context = readReportContext({
      ...OLD,
      doctor: [
        { check: "sends-claude", status: "warn", detail: "3 refused (probe_failed 3) · last 7 days", harness: "claude" },
        { check: "holds-claude", status: "fine", detail: "an unknown status word", harness: "claude" },
        { check: "screen-claude", status: "warn", harness: "claude" },
        { status: "ok", detail: "no check", harness: "claude" },
        { check: 7, status: "ok", detail: "a check that is not a string" },
        "sends-claude",
        null,
        { check: "screen-claude", status: "error", detail: "stale screen 3 · probe failed 0 · longest run 3", harness: "claude" },
        { check: "sends--", status: "skipped", detail: "no harness named" },
      ],
    });
    expect(context?.doctor).toEqual([
      { check: "sends-claude", status: "warn", detail: "3 refused (probe_failed 3) · last 7 days", harness: "claude" },
      { check: "screen-claude", status: "error", detail: "stale screen 3 · probe failed 0 · longest run 3", harness: "claude" },
      { check: "sends--", status: "skipped", detail: "no harness named", harness: "-" },
    ]);
  });

  it("keeps an empty list, and reads a field that is not a list as absent", () => {
    expect(readReportContext({ ...OLD, doctor: [] })?.doctor).toEqual([]);
    expect(readReportContext({ ...OLD, doctor: { check: "sends-claude" } })).not.toHaveProperty("doctor");
    expect(readReportContext({ ...OLD, doctor: "sends-claude" })).not.toHaveProperty("doctor");
  });

  it("a bad doctor field never costs the rest of the answer", () => {
    const context = readReportContext({ ...OLD, doctor: [{ nonsense: true }], screen: "row" });
    expect(context).toMatchObject({ collie: "1.24.2", harness: "claude", screen: "row", doctor: [] });
  });
});
