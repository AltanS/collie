import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import ledgerJson from "../harness/verified-versions.json";
import { asJsonObject, parseJsonObject, type JsonObject, type JsonValue } from "../json";
import {
  loadProfiles,
  parseProfile,
  ProfileError,
  profileFor,
  resetProfileLog,
  versionFromOutput,
  type Profile,
} from "./profile";
import { PROFILE_FILES } from "./profiles/index";

const PROFILES_DIR = join(import.meta.dirname, "profiles");
const profileFiles = readdirSync(PROFILES_DIR).filter((name) => name.endsWith(".json"));

function rawClaude(): JsonObject {
  const raw = parseJsonObject(readFileSync(join(PROFILES_DIR, "claude.json"), "utf8"));
  if (raw === undefined) throw new Error("claude.json is not a JSON object");
  return raw;
}

/** Set (or, with undefined, delete) the value at a path of keys inside a parsed profile. */
function change(raw: JsonObject, path: readonly (string | number)[], value: JsonValue | undefined): JsonObject {
  const copy: JsonObject = JSON.parse(JSON.stringify(raw));
  let node: JsonValue | undefined = copy;
  for (const key of path.slice(0, -1)) {
    node = Array.isArray(node) ? node[Number(key)] : asJsonObject(node)?.[String(key)];
  }
  const last = path.at(-1)!;
  if (Array.isArray(node)) node[Number(last)] = value ?? null;
  else if (value === undefined) delete asJsonObject(node)![String(last)];
  else asJsonObject(node)![String(last)] = value;
  return copy;
}

/** The error a bad file raises, so a test can read the path. */
function failure(raw: JsonValue): ProfileError {
  try {
    parseProfile(raw);
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("parseProfile accepted a bad profile");
}

describe("every profile file", () => {
  it("is registered, and parses", () => {
    expect(profileFiles.length).toBeGreaterThan(0);
    expect(Object.keys(PROFILE_FILES).toSorted()).toEqual(profileFiles.map((name) => name.replace(/\.json$/, "")).toSorted());
    for (const name of profileFiles) {
      const profile = parseProfile(parseJsonObject(readFileSync(join(PROFILES_DIR, name), "utf8"))!);
      expect(`${profile.id}.json`).toBe(name);
    }
    expect([...loadProfiles().keys()].toSorted()).toEqual(profileFiles.map((name) => name.replace(/\.json$/, "")).toSorted());
  });

  it("carries every field the spec names, in the Claude file", () => {
    const claude = parseProfile(rawClaude());
    expect(claude.identity.versionCommand).toEqual(["claude", "--version"]);
    expect(claude.versions.length).toBeGreaterThan(0);
    expect(claude.idle.frame.prompt.pattern).toContain("(?<draft>");
    expect(claude.idle.placeholders.sgr).toBe(2);
    expect(claude.idle.placeholders.texts).toContain("Press up to edit queued messages");
    expect(claude.idle.volatile.below.maxRows).toBe(8);
    expect(claude.keys.submit).toEqual(["Enter"]);
    expect(claude.keys.interrupt).toEqual(["Escape"]);
    expect(claude.keys.enterWhileRunning).toBe("queues");
    expect(claude.keys.queuedRow?.hintGap).toBe(1);
    expect(claude.reservedLeads).toEqual(["/", "!", "@"]);
    // The slice 0 lab (M56 spec 01, LAB.md table 1) named the inert character; spec 05 writes it in.
    expect(claude.probe.char).toBe("⌁");
    expect(claude.probe.status).toBe("verified");
    expect(claude.paste).toEqual({ bracketed: true });
    // M56 spec 08: an ask that left the screen is voided after this lifetime.
    expect(claude.ask).toEqual({ lifetimeMs: 5000 });
    expect(claude.hooks.PermissionRequest).toBe("ask");
    expect(claude.hooks.Stop).toBe("edge");
  });

  it("matches the long-paste form with and without a line count", () => {
    const { collapse } = parseProfile(rawClaude());
    const form = new RegExp(collapse.pattern, "u");
    expect(form.exec("[Pasted text #3]")?.groups?.lines).toBeUndefined();
    expect(form.exec("[Pasted text #3 +59 lines]")?.groups?.lines).toBe("59");
  });

  it("matches the queued rows Claude Code 2.1.301 draws (claude--v2301-working-queued-message--w100)", () => {
    const queuedRow = parseProfile(rawClaude()).keys.queuedRow!;
    const start = new RegExp(queuedRow.pattern, "u");
    const hint = new RegExp(queuedRow.hint, "u");
    expect(start.exec("❯ QUEUEDMSG please add a title")?.groups?.text).toBe("QUEUEDMSG please add a title");
    expect(start.exec("❯")).toBeNull();
    expect(hint.test("  ctrl+enter to send now")).toBe(true);
    expect(hint.test("  ctrl+enter to send now, or more")).toBe(false);
  });

  it("matches the frame anchors on a real box", () => {
    const { idle } = parseProfile(rawClaude());
    const rule = "─".repeat(40);
    expect(new RegExp(idle.frame.top.pattern, "u").test(rule)).toBe(true);
    expect(new RegExp(idle.frame.top.pattern, "u").test("── lab-project ──")).toBe(true);
    expect(new RegExp(idle.frame.bottom.pattern, "u").test(rule)).toBe(true);
    const prompt = new RegExp(idle.frame.prompt.pattern, "u");
    expect(prompt.exec("❯ hello there")?.groups?.draft).toBe("hello there");
    expect(prompt.exec("❯")?.groups?.draft).toBeUndefined();
    expect(prompt.exec("!important")).toBeNull();
  });
});

describe("parseProfile names the failing field", () => {
  const cases: [string, (string | number)[], JsonValue | undefined, string][] = [
    ["a missing section", ["keys"], undefined, "keys"],
    ["a missing nested field", ["keys", "clear", "slack"], undefined, "keys.clear.slack"],
    ["a wrong type", ["idle", "volatile", "below", "maxRows"], "8", "idle.volatile.below.maxRows"],
    ["an unknown status", ["versions", 0, "status"], "good", "versions[0].status"],
    ["a bad range", ["versions", 0, "range"], "2.1 to 2.2", "versions[0].range"],
    ["a range that ends before it starts", ["versions", 0, "range"], "2.1.9 - 2.1.1", "versions[0].range"],
    ["a verified range with no proof", ["versions", 0, "verifiedOn"], null, "versions[0]"],
    ["no ranges at all", ["versions"], [], "versions"],
    ["a broken expression", ["collapse", "pattern"], "[unclosed", "collapse.pattern"],
    ["a prompt anchor with no hole", ["idle", "frame", "prompt", "pattern"], "^❯ .*$", "idle.frame.prompt.pattern"],
    ["a missing tail bound", ["idle", "frame", "maxTailRows"], undefined, "idle.frame.maxTailRows"],
    ["Escape as the clear key", ["keys", "clear", "key"], "Escape", "keys.clear.key"],
    ["a probe of two characters", ["probe", "char"], "ab", "probe.char"],
    ["a paste flag that is not a boolean", ["paste", "bracketed"], "yes", "paste.bracketed"],
    ["an ask lifetime that is not a whole number", ["ask", "lifetimeMs"], 1.5, "ask.lifetimeMs"],
    ["an ask lifetime below its floor", ["ask", "lifetimeMs"], 10, "ask.lifetimeMs"],
    ["an unknown hook kind", ["hooks", "Stop"], "level", "hooks.Stop"],
    ["an unknown edge kind", ["edges", "events", "Stop"], "level", "edges.events.Stop"],
    ["an edge on an event hooks does not list as an edge", ["edges", "events", "PermissionRequest"], "dialog", "edges.events.PermissionRequest"],
    ["an edge key that is not Event or Event:detail", ["edges", "events", "Stop now"], "stop", "edges.events.Stop now"],
    ["a settle time below its floor", ["edges", "settleMs"], 10, "edges.settleMs"],
    ["a missing re-read delay", ["edges", "rereadMs"], undefined, "edges.rereadMs"],
    ["an empty submit key list", ["keys", "submit"], [], "keys.submit"],
    ["a bad id", ["id"], "Claude Code", "id"],
    ["a queued row pattern with no text group", ["keys", "queuedRow", "pattern"], "^❯ .*$", "keys.queuedRow.pattern"],
    ["a queued row hint that is no expression", ["keys", "queuedRow", "hint"], "[unclosed", "keys.queuedRow.hint"],
    ["a queued row gap below zero", ["keys", "queuedRow", "hintGap"], -1, "keys.queuedRow.hintGap"],
  ];
  for (const [name, path, value, field] of cases) {
    it(name, () => {
      expect(failure(change(rawClaude(), path, value)).path).toBe(field);
    });
  }

  it("refuses something that is not an object", () => {
    expect(failure(null).path).toBe("profile");
    expect(failure([]).path).toBe("profile");
  });
});

describe("profileFor", () => {
  beforeEach(() => resetProfileLog());

  /** The Claude file under another id, with the given ranges. */
  function demo(ranges: JsonValue): ReadonlyMap<string, Profile> {
    const raw = change(change(rawClaude(), ["id"], "demo"), ["versions"], ranges);
    return new Map([["demo", parseProfile(raw)]]);
  }

  /** A profile with three ranges: verified, revoked, verified, and a gap after the last. */
  function layered(): ReadonlyMap<string, Profile> {
    return demo([
      { range: "1.0.0 - 1.4.9", status: "verified", verifiedThrough: "1.4.9", verifiedOn: "2026-01-01" },
      { range: "1.5.0 - 1.5.9", status: "revoked", verifiedThrough: null, verifiedOn: null },
      { range: "1.6.0 - 1.9.9", status: "verified", verifiedThrough: "1.9.9", verifiedOn: "2026-02-01" },
    ]);
  }

  it("returns the verified status inside a verified range", () => {
    const lines: string[] = [];
    const match = profileFor("demo", "1.2.3", { profiles: layered(), log: (line) => lines.push(line) });
    expect(match?.status).toBe("verified");
    expect(match?.range?.range).toBe("1.0.0 - 1.4.9");
    expect(lines).toEqual([]);
  });

  it("returns the revoked profile inside a revoked range, and logs it once", () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const profiles = layered();
    expect(profileFor("demo", "1.5.2", { profiles, log })?.status).toBe("revoked");
    expect(profileFor("demo", "1.5.2", { profiles, log })?.status).toBe("revoked");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1.5.2");
    expect(profileFor("demo", "1.5.3", { profiles, log })?.status).toBe("revoked");
    expect(lines).toHaveLength(2);
  });

  it("falls back to the nearest older profile as provisional above every range", () => {
    const lines: string[] = [];
    const match = profileFor("demo", "2.0.0", { profiles: layered(), log: (line) => lines.push(line) });
    expect(match?.status).toBe("provisional");
    expect(match?.profile.id).toBe("demo");
    expect(match?.range?.range).toBe("1.6.0 - 1.9.9");
    expect(lines).toHaveLength(1);
  });

  it("falls back as provisional in a gap, taking the range below it", () => {
    const profiles = demo([
      { range: "1.0.0 - 1.1.0", status: "verified", verifiedThrough: "1.1.0", verifiedOn: "2026-01-01" },
      { range: "1.5.0 - 1.6.0", status: "verified", verifiedThrough: "1.6.0", verifiedOn: "2026-01-02" },
    ]);
    const match = profileFor("demo", "1.3.0", { profiles, log: () => {} });
    expect(match?.status).toBe("provisional");
    expect(match?.range?.range).toBe("1.0.0 - 1.1.0");
  });

  it("treats a version below every range as provisional", () => {
    const match = profileFor("demo", "0.9.0", { profiles: layered(), log: () => {} });
    expect(match?.status).toBe("provisional");
  });

  it("gives provisional when the binary version cannot be read", () => {
    const lines: string[] = [];
    const match = profileFor("demo", null, { profiles: layered(), log: (line) => lines.push(line) });
    expect(match?.status).toBe("provisional");
    expect(match?.version).toBeNull();
    expect(lines[0]).toContain("could not be read");
  });

  it("returns null for a harness with no profile", () => {
    expect(profileFor("nothing-here", "1.0.0", { log: () => {} })).toBeNull();
  });

  it("reads the version from the binary's own output, never a screen", () => {
    const claude = parseProfile(rawClaude());
    expect(versionFromOutput(claude, "2.1.300 (Claude Code)")).toBe("2.1.300");
    expect(versionFromOutput(claude, "no version here")).toBeNull();
  });
});

describe("the Claude ranges and the ledger", () => {
  const row = ledgerJson.agents.claude;

  it("agree: verified through the ledger's Claude row", () => {
    const claude = loadProfiles().get("claude")!;
    const verified = claude.versions.filter((range) => range.status === "verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]!.verifiedThrough).toBe(row.version);
    expect(verified[0]!.verifiedOn).toBe(row.verified);
    expect(verified[0]!.range.endsWith(` - ${row.version}`)).toBe(true);
    expect(profileFor("claude", row.version, { log: () => {} })?.status).toBe("verified");
  });

  it("agree: provisional above the ledger's Claude row", () => {
    const [major, minor, patch] = row.version.split(".").map(Number);
    const above = `${String(major)}.${String(minor)}.${String(patch! + 1)}`;
    resetProfileLog();
    const match = profileFor("claude", above, { log: () => {} });
    expect(match?.status).toBe("provisional");
    expect(match?.profile.id).toBe("claude");
  });

  it("holds provisional for Claude 2.1.300, the field version of 2026-10-15", () => {
    expect(profileFor("claude", "2.1.300", { log: () => {} })?.status).toBe("provisional");
  });
});
