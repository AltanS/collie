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

  test("none keeps the envelope and drops every string body", () => {
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
    expect(raw).toContain("chars⟩");
  });

  test("the length is kept, because 'was anything sent' is the question a reader asks", () => {
    const line = JSON.parse(formatAuditLine(entry, 0, "none"));
    expect(line.detail.text).toBe(`⟨${entry.detail.text.length} chars⟩`);
  });
});
