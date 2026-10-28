import { describe, expect, it } from "vitest";

import type { SendReceiptRow } from "../surface/send";
import { readReportContext } from "./context";
import { FIELD_IDS, fitLink, hasTyped, ISSUE_URL_MAX, issueLink, reportFields, reportText, searchLink, sendLine, signature, type ClientFacts, type ReportContext, type ReportInput } from "./body";
import type { DialogTrouble } from "./store";

const CONTEXT: ReportContext = { collie: "1.24.1+abc1234", line: "edge", os: "linux", arch: "x64", mux: "herdr", harness: "claude", screenable: true };
const AT = Date.parse("2026-10-25T18:00:00Z");

function row(n: number, extra: Partial<SendReceiptRow> = {}): SendReceiptRow {
  return {
    requestId: `rep-${String(n).padStart(6, "0")}`,
    at: AT + n * 1000,
    mode: "send",
    outcome: "refused",
    reason: "probe_failed",
    keys: ["probe", "Backspace"],
    gapsMs: { probe: 120, s0: 18 },
    harness: "claude",
    version: "2.1.291",
    profileId: "claude@2.1",
    profileStatus: "verified",
    detail: "The probe character changed more than the box.",
    saw: { turn: "idle", modal: "none", composer: "empty" },
    line: "deploy it now",
    ...extra,
  };
}

const SENDS = [row(3), row(2), row(1)];
const BASE: ReportInput = { context: CONTEXT, sends: SENDS, note: "", includeTyped: false, screen: null, app: "1.24.1" };

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("reportFields: local paths stay on the machine", () => {
  it("never prints a row's binary, even from a bridge that sent it", () => {
    const withPath = { ...row(1), binary: "/home/op/.local/share/omp/versions/18.12.6/omp" };
    const input: ReportInput = { ...BASE, sends: [withPath], includeTyped: true, note: "x" };
    const fields = reportFields(input);
    const everything = [fields.title, fields.what, fields.sends, fields.setup, fields.screen, reportText(fields), issueLink(fields), searchLink(input)].join("\n");
    expect(everything).not.toContain("/home/op");
    expect(everything).not.toContain("binary");
    expect(decodeURIComponent(everything)).not.toContain("/home/op");
  });
});

describe("reportFields: what a report holds by default", () => {
  it("names the trouble, the harness and version from the receipt, and the mux, in the title and the signature", () => {
    const fields = reportFields(BASE);
    expect(fields.title).toBe("Send not landing: refused/probe_failed, claude 2.1.291, herdr");
    expect(signature(BASE)).toBe("collie-sig: send/probe_failed/claude@2.1.291/herdr");
    expect(fields.sends.split("\n").at(-1)).toBe("collie-sig: send/probe_failed/claude@2.1.291/herdr");
  });

  it("lists each send oldest first with id, outcome, reason, keys, gaps, words and detail, and never the text", () => {
    const fields = reportFields(BASE);
    expect(fields.sends).toContain("id=rep-000001");
    expect(fields.sends.indexOf("rep-000001")).toBeLessThan(fields.sends.indexOf("rep-000003"));
    expect(sendLine(row(1), false)).toBe(
      "2026-10-25T18:00:01.000Z  refused/probe_failed  id=rep-000001  mode=send  keys=probe,Backspace  gapsMs=s0:18,probe:120  saw=idle/none/empty\n    detail: The probe character changed more than the box.",
    );
    expect(reportText(fields)).not.toContain("deploy it now");
    expect(fields.screen).toBe("");
  });

  it("puts the setup in one JSON block: version, line, OS, mux, harness, version and profile", () => {
    expect(JSON.parse(reportFields(BASE).setup)).toEqual({
      collie: "1.24.1+abc1234",
      line: "edge",
      app: "1.24.1",
      os: "linux/x64",
      mux: "herdr",
      harness: "claude",
      version: "2.1.291",
      profile: "claude@2.1",
      profileStatus: "verified",
    });
  });

  it("keeps the person's own line, and says what happened when they wrote none", () => {
    expect(reportFields(BASE).what).toBe("Sending kept failing on one pane.");
    expect(reportFields({ ...BASE, note: "  sending a reply to claude  " }).what).toBe("sending a reply to claude");
  });

  it("with no failed send and no pane it is a plain problem report", () => {
    const input: ReportInput = { ...BASE, context: { ...CONTEXT, harness: null }, sends: [], episodes: [{ at: AT, paneId: "w1:p2", sends: [{ requestId: "ep-0000001", outcome: "unknown", reason: "no_evidence" }] }] };
    const fields = reportFields(input);
    expect(fields.title).toBe("Problem report: no pane, herdr");
    expect(fields.sends).toContain("Earlier on this device:");
    expect(fields.sends).toContain("pane=w1:p2  unknown/no_evidence id=ep-0000001");
  });
});

describe("the two switches change the body", () => {
  it("Include what I typed adds the line the bridge kept, under its send", () => {
    expect(hasTyped(SENDS)).toBe(true);
    expect(hasTyped([row(1, { line: undefined })])).toBe(false);
    const fields = reportFields({ ...BASE, includeTyped: true });
    expect(fields.sends).toContain("    typed: deploy it now");
  });

  it("Include the screen adds the masked rows as their own field", () => {
    const fields = reportFields({ ...BASE, screen: "❯ hello\n• • •" });
    expect(fields.screen).toBe("❯ hello\n• • •");
    expect(reportText(fields)).toContain("### The screen\n\n❯ hello");
  });
});

describe("the link", () => {
  it("opens the from-app form with the title and every field by its id, and asks for no label", () => {
    const fields = reportFields({ ...BASE, screen: "row" });
    const params = query(issueLink(fields));
    expect(issueLink(fields).startsWith("https://github.com/AltanS/collie/issues/new?")).toBe(true);
    expect(params.get("template")).toBe("from-app.yml");
    expect(params.get("title")).toBe(fields.title);
    expect(params.get(FIELD_IDS.what)).toBe(fields.what);
    expect(params.get(FIELD_IDS.sends)).toBe(fields.sends);
    expect(params.get(FIELD_IDS.setup)).toBe(fields.setup);
    expect(params.get(FIELD_IDS.screen)).toBe("row");
    expect(params.has("labels")).toBe(false);
    expect(query(issueLink(reportFields(BASE))).has(FIELD_IDS.screen)).toBe(false);
  });

  it("a short report fits whole: nothing cut, the preview is the whole text", () => {
    const fields = reportFields(BASE);
    const link = fitLink(fields);
    expect(link.cut).toEqual({ screen: "none", sends: 0, note: false });
    expect(link.fields).toEqual(fields);
    expect(link.url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
  });

  it("cuts the screen first, from its top, and keeps the bottom rows", () => {
    const screen = Array.from({ length: 40 }, (_, i) => `row ${String(i).padStart(2, "0")} ${"y".repeat(120)}`).join("\n");
    const link = fitLink(reportFields({ ...BASE, screen }));
    expect(link.url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(link.cut.screen).toBe("part");
    expect(link.cut.sends).toBe(0);
    expect(link.fields.screen.split("\n").at(-1)).toContain("row 39");
    expect(link.fields.screen).not.toContain("row 00");
    expect(link.fields.sends).toBe(reportFields(BASE).sends);
  });

  it("then drops the oldest sends, keeping the signature line, and stays under the limit", () => {
    const long = Array.from({ length: 10 }, (_, i) => row(i + 1, { detail: "d".repeat(240) })).toReversed();
    const input: ReportInput = { ...BASE, sends: long, screen: "z".repeat(4000) };
    const link = fitLink(reportFields(input), 3000);
    expect(link.url.length).toBeLessThanOrEqual(3000);
    expect(link.cut.screen).toBe("all");
    expect(link.cut.sends).toBeGreaterThan(0);
    expect(link.fields.sends).not.toContain("id=rep-000001");
    expect(link.fields.sends).toContain("id=rep-000010");
    expect(link.fields.sends.split("\n").at(-1)).toBe(signature(input));
    expect(link.cut.note).toBe(false);
  });

  it("cuts the person's own line last", () => {
    const link = fitLink(reportFields({ ...BASE, note: "w".repeat(3000) }), 1500);
    expect(link.url.length).toBeLessThanOrEqual(1500);
    expect(link.cut.note).toBe(true);
    expect(link.cut.sends).toBe(3);
  });

  it("ends even when nothing can make the link fit", () => {
    const link = fitLink(reportFields({ ...BASE, note: "w".repeat(50) }), 10);
    expect(link.cut.note).toBe(true);
    expect([...link.fields.what].length).toBeLessThanOrEqual(2);
  });

  it("the duplicate search looks for the signature line", () => {
    expect(decodeURIComponent(searchLink(BASE))).toBe('https://github.com/AltanS/collie/issues?q=is:issue "collie-sig: send/probe_failed/claude@2.1.291/herdr"');
  });
});

describe("readReportContext", () => {
  it("reads the bridge's answer field by field and refuses a body that is not one", () => {
    expect(readReportContext({ ...CONTEXT, screen: "x" })).toEqual({ ...CONTEXT, screen: "x" });
    expect(readReportContext({ ...CONTEXT, line: "nightly", harness: null })).toEqual({ ...CONTEXT, line: null, harness: null });
    expect(readReportContext({ collie: "1.0.0" })).toBeNull();
    expect(readReportContext("<html>")).toBeNull();
  });
});

describe("reportFields: from the unread-dialog card (amendment 2026-10-28, #554)", () => {
  const DIALOG: DialogTrouble = {
    agent: "claude",
    key: "Escape",
    verdicts: [
      { name: "prompt-select", result: "null" },
      { name: "menu", result: "threw: row 3 out of range" },
      { name: "autocomplete", result: "found" },
    ],
  };
  const CLIENT: ClientFacts = { appBuild: "1.24.2-abc1234", serverBuild: "1.24.2-def5678", userAgent: "Mozilla/5.0 (Linux; Android 16) Test", viewport: "412x915", standalone: true };
  const INPUT: ReportInput = { ...BASE, dialog: DIALOG, client: CLIENT };

  it("titles the report by the dialog, with the harness and version from the receipt and the mux", () => {
    expect(reportFields(INPUT).title).toBe("Cannot read a dialog: claude 2.1.291, herdr");
    expect(reportFields({ ...INPUT, sends: [] }).title).toBe("Cannot read a dialog: claude, herdr");
    // No receipt and no context: the card's own adapter names the harness.
    expect(reportFields({ ...INPUT, sends: [], context: null }).title).toBe("Cannot read a dialog: claude, unknown mux");
  });

  it("holds the card's reason line and every detector's verdict instead of the sends, then the signature", () => {
    const fields = reportFields(INPUT);
    expect(fields.sends).toBe(
      [
        "Collie cannot read this dialog.",
        "    card key: Escape",
        "    detectors of the claude reader on this screen:",
        "    prompt-select: null",
        "    menu: threw: row 3 out of range",
        "    autocomplete: found",
        "collie-sig: dialog/unread/claude@2.1.291/herdr",
      ].join("\n"),
    );
    expect(fields.sends).not.toContain("rep-000003");
    expect(signature(INPUT)).toBe("collie-sig: dialog/unread/claude@2.1.291/herdr");
    expect(fields.what).toBe("The phone showed a dialog it could not read.");
    expect(reportText(fields)).toContain("### What went wrong\n\nCollie cannot read this dialog.");
  });

  it("says so when the adapter names no detectors", () => {
    expect(reportFields({ ...INPUT, dialog: { ...DIALOG, verdicts: [] } }).sends).toContain("    (this adapter names no dialog detectors)");
  });

  it("adds the phone's build, the bridge's build, the browser, the viewport and standalone to the setup", () => {
    const setup: unknown = JSON.parse(reportFields(INPUT).setup);
    expect(setup).toMatchObject({
      collie: "1.24.1+abc1234",
      mux: "herdr",
      appBuild: "1.24.2-abc1234",
      serverBuild: "1.24.2-def5678",
      userAgent: "Mozilla/5.0 (Linux; Android 16) Test",
      viewport: "412x915",
      standalone: "yes",
    });
    expect(JSON.parse(reportFields({ ...INPUT, client: { ...CLIENT, standalone: false, serverBuild: null } }).setup)).toMatchObject({ standalone: "no", serverBuild: null });
    // A report about sends keeps its setup as it was.
    expect(JSON.parse(reportFields(BASE).setup)).not.toHaveProperty("userAgent");
  });

  it("cuts the screen to fit and never the reason line or a verdict", () => {
    const screen = Array.from({ length: 40 }, (_, i) => `row ${String(i)} ${"x".repeat(200)}`).join("\n");
    const link = fitLink(reportFields({ ...INPUT, screen }));
    expect(link.url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(link.cut.screen).not.toBe("none");
    expect(link.cut.sends).toBe(0);
    expect(link.fields.sends).toBe(reportFields(INPUT).sends);
  });
});
