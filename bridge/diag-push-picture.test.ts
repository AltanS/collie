import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PUSH_PICTURE_VERDICTS as PHONE_VERDICTS } from "../web/src/lib/project-picture-push.ts";
import { loadConfig } from "./config.ts";
import { crewRouteFor } from "./crew/forward.ts";
import {
  DIAG_PUSH_PICTURE_DEVICE_MS,
  DIAG_PUSH_PICTURE_HOUR_MAX,
  parsePushPictureDiag,
  PUSH_PICTURE_DIAG_KEYS,
  PUSH_PICTURE_VERDICTS,
  PushPictureDiagLimit,
  pushPictureDiagLine,
} from "./diag-push-picture.ts";
import { DEVICES_FILENAME, filePairingIo, PairingStore, sha256Hex } from "./pairing.ts";
import { guard } from "./server.ts";

// THE PUSH PICTURE TRACE (round 19): a fixed list and two build ids in, one log line out, nothing kept.

const GOOD = { verdict: "no-copy", machine: "member", ageS: 125, workerBuild: "1.29.1-dev+0072de30c4.1795163609", pageBuild: "1.29.1-dev+d794485c15.1795170000" } as const;

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("the record", () => {
  test("a good record is kept whole, and its key set is the fixed one", () => {
    expect(parsePushPictureDiag(GOOD)).toEqual(GOOD);
    expect(Object.keys(GOOD).toSorted()).toEqual([...PUSH_PICTURE_DIAG_KEYS]);
  });

  test("the bridge's verdicts are the phone's verdicts", () => {
    expect([...PUSH_PICTURE_VERDICTS]).toEqual([...PHONE_VERDICTS]);
  });

  test("every verdict on the list passes, and nothing else does", () => {
    for (const verdict of PUSH_PICTURE_VERDICTS) expect(parsePushPictureDiag({ ...GOOD, verdict })?.verdict).toBe(verdict);
    for (const verdict of ["", "maybe", "no copy", 3, null]) expect(parsePushPictureDiag({ ...GOOD, verdict })).toBeNull();
  });

  test("no text can ride it: another key, a machine name, a path or words in a build, a bad age", () => {
    expect(parsePushPictureDiag({ ...GOOD, pane: "w28:p1" })).toBeNull();
    expect(parsePushPictureDiag({ verdict: "shown", machine: "lead", ageS: 0, workerBuild: "x" })).toBeNull();
    expect(parsePushPictureDiag({ ...GOOD, machine: "laptop" })).toBeNull();
    for (const build of ["/home/you/repo/logo.png", "../x", "a b", "", "x".repeat(81), "1.0\n[diag] forged"]) {
      expect(parsePushPictureDiag({ ...GOOD, workerBuild: build })).toBeNull();
      expect(parsePushPictureDiag({ ...GOOD, pageBuild: build })).toBeNull();
    }
    for (const ageS of [-1, 1.5, "60", 31 * 24 * 3600]) expect(parsePushPictureDiag({ ...GOOD, ageS })).toBeNull();
    for (const body of [null, [], "no-copy", undefined]) expect(parsePushPictureDiag(body)).toBeNull();
  });
});

describe("the log line", () => {
  test("says the verdict, whose pane, how long ago, both builds and whether they differ", () => {
    expect(pushPictureDiagLine(parsePushPictureDiag(GOOD)!, "pixel")).toBe(
      "[diag] push picture: none (no-copy) for a member's pane, 2m ago; worker 1.29.1-dev+0072de30c4.1795163609 page 1.29.1-dev+d794485c15.1795170000 (they differ); device pixel",
    );
    const same = parsePushPictureDiag({ ...GOOD, verdict: "shown", machine: "lead", ageS: 30, pageBuild: GOOD.workerBuild })!;
    expect(pushPictureDiagLine(same, null)).toBe(`[diag] push picture: shown for the lead's own pane, 30s ago; worker ${GOOD.workerBuild} page ${GOOD.workerBuild} (the same build); device this host`);
  });

  test("a device label cannot break the line", () => {
    expect(pushPictureDiagLine(parsePushPictureDiag(GOOD)!, "phone\n[diag] forged")).toEndWith("device phone[diag] forged");
  });
});

describe("the rate limit", () => {
  test("one line per device a minute, and the hour's total for all devices", () => {
    const limit = new PushPictureDiagLimit();
    expect(limit.allow("pixel", 0)).toBe(true);
    expect(limit.allow("pixel", DIAG_PUSH_PICTURE_DEVICE_MS - 1)).toBe(false);
    expect(limit.allow("laptop", 1)).toBe(true);
    expect(limit.allow("pixel", DIAG_PUSH_PICTURE_DEVICE_MS)).toBe(true);
    const flood = new PushPictureDiagLimit();
    const allowed = Array.from({ length: 100 }, (_, i) => flood.allow(`device-${String(i)}`, i)).filter(Boolean).length;
    expect(allowed).toBe(DIAG_PUSH_PICTURE_HOUR_MAX);
    expect(flood.allow("late", 3_600_000)).toBe(true);
  });
});

describe("the route", () => {
  const TOKEN = "tok-phone-placeholder";
  const request = (headers: Record<string, string> = {}): Request =>
    new Request("http://127.0.0.1:8787/api/diag/push-picture", {
      method: "POST",
      headers: { host: "127.0.0.1:8787", "content-type": "application/json", ...headers },
      body: JSON.stringify(GOOD),
    });
  const config = () => loadConfig({ HOME: "/tmp/collie-diag-push-picture-home" });

  async function store(paired: boolean): Promise<PairingStore> {
    const dir = await mkdtemp(join(tmpdir(), "collie-diag-push-picture-"));
    dirs.push(dir);
    if (paired) {
      const now = Date.now();
      await writeFile(join(dir, DEVICES_FILENAME), JSON.stringify({ devices: [{ label: "phone", tokenHash: sha256Hex(TOKEN), createdAt: now, lastSeenAt: now }] }));
    }
    return new PairingStore(filePairingIo(dir));
  }

  test("an unpaired device is refused at the read gate, a paired one passes", async () => {
    const paired = await store(true);
    expect(guard(request(), config(), "read", paired)?.status).toBe(403);
    expect(guard(request({ authorization: "Bearer not-the-token" }), config(), "read", paired)?.status).toBe(403);
    expect(guard(request({ authorization: `Bearer ${TOKEN}` }), config(), "read", paired)).toBeNull();
  });

  test("is read-gated, checks the body before it logs, keeps nothing and answers 204 (by source)", () => {
    const code = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const at = code.indexOf('pathname === "/api/diag/push-picture"');
    expect(at).toBeGreaterThan(0);
    const block = code.slice(at, code.indexOf("\n      }\n", at));
    expect(block).toContain('browserGate("read")');
    expect(block).toContain("DIAG_PUSH_PICTURE_BODY_MAX");
    expect(block.indexOf("parsePushPictureDiag(body)")).toBeLessThan(block.indexOf("console.log("));
    expect(block).toContain("pushPictureDiag.allow(");
    expect(block).toContain('text("bad push picture record", 400)');
    expect(block).toContain("status: 204");
    for (const kept of ["writeFile", "appendFile", ".record(", "host.kind"]) expect(block).not.toContain(kept);
  });

  test("is never forwarded to a crew member", () => {
    expect(crewRouteFor("/api/diag/push-picture", "POST")).toBeNull();
  });
});
