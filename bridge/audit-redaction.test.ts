import { describe, expect, test } from "bun:test";
import { formatAuditLine } from "./audit";

const entry = {
  action: "reply",
  paneId: "w1:p1",
  session: "default",
  detail: {
    text: "deploy the thing and here is a secret nobody should keep on disk",
    submit: true,
    promptBinding: { checked: true, passed: true, expected: "user@host ~/work %" },
  },
};

describe("audit content redaction", () => {
  test("preview is unchanged — the default must not move", () => {
    const line = JSON.parse(formatAuditLine(entry, 0));
    expect(line.detail.text).toContain("deploy the thing");
    expect(line.detail.promptBinding.expected).toContain("user@host");
  });

  test("none keeps the envelope and every non-string parameter", () => {
    const line = JSON.parse(formatAuditLine(entry, 0, "none"));
    expect(line.action).toBe("reply");
    expect(line.paneId).toBe("w1:p1");
    expect(line.session).toBe("default");
    expect(line.detail.submit).toBe(true);
    expect(line.detail.promptBinding.checked).toBe(true);
    expect(line.detail.promptBinding.passed).toBe(true);
  });

  test("⛔ nothing of the message survives, at any nesting depth", () => {
    const raw = formatAuditLine(entry, 0, "none");
    expect(raw).not.toContain("deploy");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("user@host");
    expect(raw).toContain("⟨redacted⟩");
  });

  test("⛔ the redaction is a constant — an exact length is itself content", () => {
    const line = JSON.parse(formatAuditLine(entry, 0, "none"));
    expect(line.detail.text).toBe("⟨redacted⟩");
    expect(line.detail.promptBinding.expected).toBe("⟨redacted⟩");
    expect(String(line.detail.text)).not.toMatch(/\d/);
  });

  test("an allowlisted key survives, including through the array it names", () => {
    const line = JSON.parse(
      formatAuditLine(
        { action: "keys", detail: { keys: ["ctrl+c", "Enter"], sent: false } },
        0,
        "none",
      ),
    );
    expect(line.detail.keys).toEqual(["ctrl+c", "Enter"]);
    expect(line.detail.sent).toBe(false);
  });

  test("⛔ an upload's client-declared filename redacts; the saved name identifies the entry", () => {
    const line = JSON.parse(
      formatAuditLine(
        {
          action: "upload",
          detail: { filename: "my-passport-scan.png", size: 4096, saved: "w1_p1-abc-1234.png" },
        },
        0,
        "none",
      ),
    );
    expect(line.detail.filename).toBe("⟨redacted⟩");
    expect(line.detail.size).toBe(4096);
    expect(line.detail.saved).toBe("w1_p1-abc-1234.png");
  });

  test("⛔ a string under an unlisted key redacts — the allowlist fails closed", () => {
    const line = JSON.parse(
      formatAuditLine(
        { action: "reply", detail: { somethingAddedLater: "a body nobody classified" } },
        0,
        "none",
      ),
    );
    expect(line.detail.somethingAddedLater).toBe("⟨redacted⟩");
  });

  test("⛔ a toJSON smuggle cannot re-inject content at stringify time", () => {
    const smuggle = {
      action: "reply",
      detail: { text: "x", evil: { toJSON: () => "smuggled-secret", keys: ["ctrl+c"] } },
    };
    const raw = formatAuditLine(smuggle, 0, "none");
    expect(raw).not.toContain("smuggled-secret");
    expect(JSON.parse(raw).detail.evil.keys).toEqual(["ctrl+c"]);
  });

  test("a function-valued property doesn't break preview mode either", () => {
    const raw = formatAuditLine(
      { action: "reply", detail: { text: "hello", cb: () => "nope" } },
      0,
    );
    expect(raw).not.toContain("nope");
    const line = JSON.parse(raw);
    expect(line.detail.text).toBe("hello");
    expect(line.detail.cb).toBeUndefined();
  });
});
