import { describe, expect, test } from "bun:test";

import { PACK_PROTOCOL_VERSION } from "../bridge/pack/enrollment.ts";
import { leadStore, member, PACK, peerStore, T0 } from "../bridge/pack/fixtures.ts";
import { markerFor } from "../bridge/pack/staleness.ts";
import { serializeTrustStore, TrustStore, type TrustStoreData, type TrustStoreIo } from "../bridge/pack/trust-store.ts";
import { cmdDoctor, type DoctorDeps, type Finding } from "./doctor.ts";
import type { DoctorView, Ui } from "./render.ts";
import { capture, context, CONFIG, fakeExec, fakeFiles, ROOT, STATE, type Scripted } from "./fakes.ts";
import { EXIT } from "./io.ts";

// `collie doctor`, against fakes for every seam. Like cli/pack.test.ts, NOTHING here reaches a
// service manager, a tailnet, a real trust store or a network — and unlike it, there is nothing to
// reach even in principle: `DoctorDeps` names no verb that could change something, so a test that
// wanted to assert "doctor wrote nothing" is asserting a type, not a behaviour. It is asserted
// anyway (the fake filesystem records every write), because the read-only contract is the reason
// this verb is safe to run on a machine that is already misbehaving.

const HANDLER = `${CONFIG}/tailscale-managed-handler`;
const SOCKET = "/home/pat/.config/herdr/herdr.sock";
const HOSTPORT = "laptop.tail.ts.net:443";
const PROXY = "http://127.0.0.1:8787";

/** A `tailscale serve status --json` in which Collie's own root mount is live. */
const SERVE_OK = JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: { [HOSTPORT]: { Handlers: { "/": { Proxy: PROXY } } } },
});
/** A netmap whose inbound packet filter admits somebody — the "can't disprove" case. */
const NETMAP_OPEN = JSON.stringify({ PacketFilter: [{ IPProto: ["tcp"] }] });
/** A netmap whose inbound packet filter is EMPTY — deny-all, the only thing this probe can prove. */
const NETMAP_DENY = JSON.stringify({ PacketFilter: [] });

/**
 * The netmap probe is bounded through `timeout(1)` where it exists, and the fake `Exec` says every
 * tool exists — so the call it actually makes is `timeout 3 /fake/tailscale debug netmap`. Both
 * spellings are scripted, so the fixture does not silently stop matching if that bound is dropped.
 */
const netmapAnswers = (json: string): NonNullable<Scripted["answers"]> => [
  ["timeout 3 /fake/tailscale debug netmap", { stdout: json }],
  ["tailscale debug netmap", { stdout: json }],
];

const HEALTHY_ANSWERS: Scripted["answers"] = [
  ["tailscale status --json", { stdout: JSON.stringify({ Self: { DNSName: "laptop.tail.ts.net." } }) }],
  ["tailscale serve status --json", { stdout: SERVE_OK }],
  ...netmapAnswers(NETMAP_OPEN),
];

/** The files a healthy install has: a built bundle, a Herdr socket, an ownership record. */
function healthyFiles(): Record<string, string> {
  return {
    [`${ROOT}/web/dist/index.html`]: "<!doctype html>",
    [`${ROOT}/web/dist/assets/app.js`]: "//",
    [`${ROOT}/web/dist/build-info.json`]: JSON.stringify({ version: "1.0.0-alpha.12" }),
    [SOCKET]: "",
    [HANDLER]: `https:443|${HOSTPORT}|${PROXY}\n`,
  };
}

interface Harness {
  deps: DoctorDeps;
  io: ReturnType<typeof capture>;
  files: ReturnType<typeof fakeFiles>;
  requests: string[];
}

/**
 * Build a harness. `initial` is the trust store on disk (`null` = never enrolled), `replies` answers
 * each `hello` in order, and `over` replaces any seam or the seeded filesystem.
 */
/**
 * A recording stand-in for the terminal renderer. Its presence is the whole of the seam: `doctor`
 * hands it the findings it would otherwise have formatted, and prints nothing itself.
 */
function fakeUi(): { ui: Ui; views: DoctorView[] } {
  const views: DoctorView[] = [];
  return {
    views,
    ui: {
      doctor: async (view) => void views.push(view),
      status: async () => {},
      packMembers: async () => {},
    },
  };
}

function harness(
  initial: TrustStoreData | null,
  replies: (Response | Error)[] = [],
  over: {
    env?: Record<string, string | undefined>;
    files?: Record<string, string>;
    answers?: Scripted["answers"];
    absent?: string[];
  } = {},
): Harness {
  const contents = initial === null ? null : serializeTrustStore(initial);
  const io: TrustStoreIo = {
    read: async () => contents,
    write: async () => {
      throw new Error("doctor must never write the trust store");
    },
  };
  const out = capture();
  const files = fakeFiles(over.files ?? healthyFiles());
  const requests: string[] = [];
  let n = 0;
  return {
    deps: {
      // As in cli/pack.test.ts: the peer client races the fake fetch against a REAL timer, so the
      // budget is set far above anything this process could stall for.
      ctx: context({ COLLIE_PACK_TIMEOUT_MS: "60000", ...over.env }, { socket: SOCKET }),
      io: out,
      exec: fakeExec({ answers: over.answers ?? HEALTHY_ANSWERS, absent: over.absent }),
      files,
      store: new TrustStore(STATE, io),
      fetch: async (url) => {
        requests.push(url);
        const reply = replies[n++];
        if (reply === undefined) return hello();
        if (reply instanceof Error) throw reply;
        return reply;
      },
      now: () => T0,
    },
    io: out,
    files,
    requests,
  };
}

/** A `hello` answer: §6's two headers, the optional §5 `version`, and an HTTP `Date` the clock reads. */
function hello(
  over: { version?: string | null; date?: number | null; memberId?: string } = {},
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-pack-protocol": String(PACK_PROTOCOL_VERSION),
    "x-pack-member": over.memberId ?? "laptop",
  };
  if (over.date !== null) headers.date = new Date(over.date ?? T0).toUTCString();
  const version = over.version === undefined ? "1.0.0-alpha.12" : over.version;
  return new Response(
    JSON.stringify({
      protocol: PACK_PROTOCOL_VERSION,
      member: over.memberId ?? "laptop",
      ...(version === null ? {} : { version }),
    }),
    { status: 200, headers },
  );
}

/** The `--json` findings, keyed by check. Every assertion below reads the contract, not the prose. */
async function findings(h: Harness): Promise<{ code: number; byCheck: Map<string, Finding>; raw: Finding[] }> {
  const code = await cmdDoctor(h.deps, ["--json"]);
  const raw = JSON.parse(h.io.stdout.join("\n")) as Finding[];
  return { code, byCheck: new Map(raw.map((f) => [f.check, f])), raw };
}

const LEAD = leadStore({ peers: [member({ memberId: "laptop" })] });

/** A boot marker that matches a store exactly — the "the running bridge holds this roster" case. */
const markerFile = (data: TrustStoreData): Record<string, string> => ({
  [`${STATE}/pack-runtime.json`]: JSON.stringify(markerFor(data, T0, 42)),
});

// ── The contract ─────────────────────────────────────────────────────────────

describe("collie doctor — the contract", () => {
  test("a healthy solo install passes everything it can run, and exits 0", async () => {
    const h = harness(null);
    const { code, byCheck, raw } = await findings(h);
    expect(code).toBe(EXIT.OK);
    expect([...byCheck.keys()]).toEqual([
      "web-dist",
      "herdr-socket",
      "bind",
      "bind-wildcard",
      "acl",
      "front-door",
      "restart-pending",
      "clock",
    ]);
    expect(raw.filter((f) => f.status !== "ok" && f.status !== "skipped")).toEqual([]);
  });

  test("`remedy` is null EXACTLY when the status is ok — including for a skipped check", async () => {
    for (const h of [harness(null), harness(LEAD), harness(peerStore())]) {
      const { raw } = await findings(h);
      for (const f of raw) expect(f.remedy === null).toBe(f.status === "ok");
    }
  });

  test("every non-✓ line names the verb that fixes it", async () => {
    // A deliberately sick install: no bundle, no socket, a deny-all filter, no front door.
    const h = harness(LEAD, [new Error("connection refused")], {
      files: { [HANDLER]: "" },
      answers: [
        ["tailscale status --json", { stdout: "{}" }],
        ["tailscale serve status --json", { stdout: "{}" }],
        ["tailscale debug netmap", { stdout: NETMAP_DENY }],
      ],
    });
    const code = await cmdDoctor(h.deps, []);
    expect(code).toBe(EXIT.FAIL);
    for (const line of h.io.stdout) {
      if (line.startsWith("  ✓") || !line.startsWith("  ")) continue;
      // Every warn/error/skipped line carries its remedy, and every remedy names something runnable.
      expect(line).toContain("→");
      expect(/`collie |`herdr |`tailscale |`timedatectl |COLLIE_/.test(line)).toBe(true);
    }
  });

  test("warnings alone exit 0; one error is enough to exit 1", async () => {
    const warned = harness(null, [], { env: { COLLIE_HOST: "0.0.0.0" } });
    const warnRun = await findings(warned);
    expect(warnRun.byCheck.get("bind-wildcard")?.status).toBe("warn");
    expect(warnRun.raw.some((f) => f.status === "error")).toBe(false);
    expect(warnRun.code).toBe(EXIT.OK);

    const broken = harness(null, [], { files: { ...healthyFiles(), [SOCKET]: undefined as never } });
    broken.files.entries.delete(SOCKET);
    const badRun = await findings(broken);
    expect(badRun.byCheck.get("herdr-socket")?.status).toBe("error");
    expect(badRun.code).toBe(EXIT.FAIL);
  });

  test("--json prints an array on stdout and nothing else", async () => {
    const h = harness(LEAD, [hello()], { files: { ...healthyFiles(), ...markerFile(LEAD) } });
    const code = await cmdDoctor(h.deps, ["--json"]);
    expect(code).toBe(EXIT.OK);
    expect(h.io.stderr).toEqual([]);
    const parsed = JSON.parse(h.io.stdout.join("\n")) as Finding[];
    expect(Array.isArray(parsed)).toBe(true);
    for (const f of parsed) {
      expect(Object.keys(f).sort()).toEqual(["check", "detail", "remedy", "status"]);
      expect(["ok", "warn", "error", "skipped"]).toContain(f.status);
    }
  });

  test("it writes nothing — no file, no store, no record", async () => {
    const h = harness(LEAD, [hello()], { files: { ...healthyFiles(), ...markerFile(LEAD) } });
    const before = new Map(h.files.entries);
    await cmdDoctor(h.deps, []);
    expect([...h.files.entries.keys()].sort()).toEqual([...before.keys()].sort());
    expect(h.files.ops).toEqual([]);
  });
});

// ── Sections ─────────────────────────────────────────────────────────────────

describe("collie doctor — the section sets", () => {
  test("solo prints ONE `no pack` line, never a column of padded skipped pack checks", async () => {
    const h = harness(null);
    await cmdDoctor(h.deps, []);
    const text = h.io.stdout.join("\n");
    expect(text).toContain("pack: none — this collie is not in a pack.");
    expect(text).toContain("mode solo");
    expect(text).not.toContain("member-reach");
    expect(text).not.toContain("store-drift");
  });

  test("a lead runs `member-reach`; a peer runs `lead-reach`", async () => {
    const lead = await findings(harness(LEAD, [hello()], { files: { ...healthyFiles(), ...markerFile(LEAD) } }));
    expect(lead.byCheck.has("member-reach")).toBe(true);
    expect(lead.byCheck.has("lead-reach")).toBe(false);

    const peer = peerStore();
    const asPeer = await findings(
      harness(peer, [hello({ memberId: "desk" })], {
        env: { COLLIE_HOST: "laptop.tail.ts.net" },
        files: { ...healthyFiles(), ...markerFile(peer), [HANDLER]: undefined as never },
      }),
    );
    expect(asPeer.byCheck.has("lead-reach")).toBe(true);
    expect(asPeer.byCheck.has("member-reach")).toBe(false);
  });
});

// ── The local checks ─────────────────────────────────────────────────────────

describe("collie doctor — the local checks", () => {
  test("web-dist: absent is an error naming `collie build`", async () => {
    const files = healthyFiles();
    delete files[`${ROOT}/web/dist/index.html`];
    delete files[`${ROOT}/web/dist/assets/app.js`];
    delete files[`${ROOT}/web/dist/build-info.json`];
    const { code, byCheck } = await findings(harness(null, [], { files }));
    expect(byCheck.get("web-dist")?.status).toBe("error");
    expect(byCheck.get("web-dist")?.remedy).toContain("collie build");
    expect(code).toBe(EXIT.FAIL);
  });

  test("herdr-socket: a missing socket is an error naming the path it looked for", async () => {
    const files = healthyFiles();
    delete files[SOCKET];
    const { byCheck } = await findings(harness(null, [], { files }));
    expect(byCheck.get("herdr-socket")?.status).toBe("error");
    expect(byCheck.get("herdr-socket")?.detail).toContain(SOCKET);
    expect(byCheck.get("herdr-socket")?.remedy).toContain("herdr status");
  });

  test("bind: a PEER on loopback is the #1 trap — an error naming the COLLIE_HOST to set", async () => {
    const peer = peerStore();
    const { code, byCheck } = await findings(
      harness(peer, [hello({ memberId: "desk" })], {
        files: { ...healthyFiles(), ...markerFile(peer), [HANDLER]: undefined as never },
      }),
    );
    const bind = byCheck.get("bind");
    expect(bind?.status).toBe("error");
    expect(bind?.detail).toContain("PEER");
    // The tailnet name this host answers with is the address it suggests — not a placeholder.
    expect(bind?.remedy).toContain("COLLIE_HOST=laptop.tail.ts.net");
    expect(code).toBe(EXIT.FAIL);
  });

  test("bind: loopback on a lead or solo is the RIGHT answer, not a finding", async () => {
    const solo = await findings(harness(null));
    expect(solo.byCheck.get("bind")?.status).toBe("ok");
    const lead = await findings(harness(LEAD, [hello()], { files: { ...healthyFiles(), ...markerFile(LEAD) } }));
    expect(lead.byCheck.get("bind")?.status).toBe("ok");
  });

  test("bind-wildcard: a wildcard warns, and a warning never fails the run", async () => {
    const { code, byCheck } = await findings(harness(null, [], { env: { COLLIE_HOST: "" } }));
    expect(byCheck.get("bind-wildcard")?.status).toBe("warn");
    expect(code).toBe(EXIT.OK);
  });

  test("acl: an EMPTY inbound filter is an error; a non-empty one passes as `can't disprove`", async () => {
    const denied = await findings(
      harness(null, [], {
        answers: [
          ["tailscale status --json", { stdout: "{}" }],
          ["tailscale serve status --json", { stdout: SERVE_OK }],
          ...netmapAnswers(NETMAP_DENY),
        ],
      }),
    );
    expect(denied.byCheck.get("acl")?.status).toBe("error");
    expect(denied.byCheck.get("acl")?.remedy).toContain("ACL");
    expect(denied.code).toBe(EXIT.FAIL);

    // THE ASYMMETRY: a non-empty filter proves nothing, and the passing line says so out loud.
    const open = await findings(harness(null));
    expect(open.byCheck.get("acl")?.status).toBe("ok");
    expect(open.byCheck.get("acl")?.detail).toContain("can't disprove");

    // No `tailscale` at all is `skipped`, never a pass.
    const none = await findings(harness(null, [], { absent: ["tailscale"] }));
    expect(none.byCheck.get("acl")?.status).toBe("skipped");
  });

  test("front-door: a live mapping matching the record passes; a replaced one warns", async () => {
    const live = await findings(harness(null));
    expect(live.byCheck.get("front-door")?.status).toBe("ok");

    const stolen = await findings(
      harness(null, [], {
        answers: [
          ["tailscale status --json", { stdout: "{}" }],
          [
            "tailscale serve status --json",
            {
              stdout: JSON.stringify({
                TCP: { "443": { HTTPS: true } },
                Web: { [HOSTPORT]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
              }),
            },
          ],
          ...netmapAnswers(NETMAP_OPEN),
        ],
      }),
    );
    // Reported, never touched (ADR 0001) — and a warning, because it is not ours to fix by force.
    expect(stolen.byCheck.get("front-door")?.status).toBe("warn");
  });

  test("front-door: a LEAD with no mapping and no COLLIE_SKIP_SERVE is an error", async () => {
    const files = { ...healthyFiles(), ...markerFile(LEAD) };
    delete files[HANDLER];
    const { code, byCheck } = await findings(
      harness(LEAD, [hello()], {
        files,
        answers: [
          ["tailscale status --json", { stdout: "{}" }],
          ["tailscale serve status --json", { stdout: "{}" }],
          ...netmapAnswers(NETMAP_OPEN),
        ],
      }),
    );
    expect(byCheck.get("front-door")?.status).toBe("error");
    expect(byCheck.get("front-door")?.remedy).toContain("collie serve");
    expect(code).toBe(EXIT.FAIL);
  });

  test("front-door: a PEER with any mapping at all is an error (ADR 0013)", async () => {
    const peer = peerStore();
    const { byCheck } = await findings(
      harness(peer, [hello({ memberId: "desk" })], {
        env: { COLLIE_HOST: "laptop.tail.ts.net" },
        files: { ...healthyFiles(), ...markerFile(peer) },
      }),
    );
    expect(byCheck.get("front-door")?.status).toBe("error");
    expect(byCheck.get("front-door")?.remedy).toContain("collie unserve");
  });

  test("front-door: COLLIE_SKIP_SERVE=1 with a leftover record warns; without one it passes", async () => {
    const files = healthyFiles();
    const withRecord = await findings(harness(null, [], { env: { COLLIE_SKIP_SERVE: "1" }, files }));
    expect(withRecord.byCheck.get("front-door")?.status).toBe("warn");

    delete files[HANDLER];
    const clean = await findings(harness(null, [], { env: { COLLIE_SKIP_SERVE: "1" }, files }));
    expect(clean.byCheck.get("front-door")?.status).toBe("ok");
  });

  test("restart-pending: skipped, because nothing the bridge writes names the code it is running", async () => {
    const { code, byCheck } = await findings(harness(null));
    const f = byCheck.get("restart-pending");
    expect(f?.status).toBe("skipped");
    expect(f?.detail).toContain("records no version");
    expect(f?.remedy).toContain("collie restart");
    expect(code).toBe(EXIT.OK);
  });
});

// ── The clock ────────────────────────────────────────────────────────────────

describe("collie doctor — the clock (§8.6's ±5m window)", () => {
  const withDate = (delta: number) =>
    harness(LEAD, [hello({ date: T0 + delta })], { files: { ...healthyFiles(), ...markerFile(LEAD) } });

  test("solo is skipped rather than compared against an invented reference", async () => {
    const { byCheck, code } = await findings(harness(null));
    expect(byCheck.get("clock")?.status).toBe("skipped");
    expect(code).toBe(EXIT.OK);
  });

  test("inside ±2m passes", async () => {
    const { byCheck, code } = await findings(withDate(60_000));
    expect(byCheck.get("clock")?.status).toBe("ok");
    expect(code).toBe(EXIT.OK);
  });

  test("past ±2m warns — in BOTH directions", async () => {
    for (const delta of [3 * 60_000, -3 * 60_000]) {
      const { byCheck, code } = await findings(withDate(delta));
      expect(byCheck.get("clock")?.status).toBe("warn");
      expect(byCheck.get("clock")?.remedy).toContain("NTP");
      expect(code).toBe(EXIT.OK);
    }
  });

  test("past ±5m is an error — in BOTH directions — and says why a 401 was the symptom", async () => {
    for (const delta of [6 * 60_000, -6 * 60_000]) {
      const { byCheck, code } = await findings(withDate(delta));
      expect(byCheck.get("clock")?.status).toBe("error");
      expect(byCheck.get("clock")?.detail).toContain("401");
      expect(code).toBe(EXIT.FAIL);
    }
  });

  test("a member that sent no readable Date is skipped, never guessed at", async () => {
    const h = harness(LEAD, [hello({ date: null })], { files: { ...healthyFiles(), ...markerFile(LEAD) } });
    const { byCheck } = await findings(h);
    expect(byCheck.get("clock")?.status).toBe("skipped");
  });
});

// ── The pack checks ──────────────────────────────────────────────────────────

describe("collie doctor — the pack checks", () => {
  test("store-drift: a roster the running bridge never wired is an error naming `collie restart`", async () => {
    // The marker was written when this lead had NO peers; the store now has one.
    const stale = markerFor(leadStore(), T0, 42);
    const { code, byCheck } = await findings(
      harness(LEAD, [hello()], {
        files: { ...healthyFiles(), [`${STATE}/pack-runtime.json`]: JSON.stringify(stale) },
      }),
    );
    expect(byCheck.get("store-drift")?.status).toBe("error");
    expect(byCheck.get("store-drift")?.detail).toContain("laptop");
    expect(byCheck.get("store-drift")?.remedy).toContain("collie restart");
    expect(code).toBe(EXIT.FAIL);
  });

  test("store-drift: no marker at all is skipped — no process exists for the store to be ahead of", async () => {
    const { byCheck } = await findings(harness(LEAD, [hello()]));
    expect(byCheck.get("store-drift")?.status).toBe("skipped");
  });

  test("secret-generation: a member behind the pack's generation warns, and does not fail the run", async () => {
    const behind = leadStore({ peers: [member({ memberId: "laptop", secretGeneration: 0 })] });
    const { code, byCheck } = await findings(
      harness(behind, [hello()], { files: { ...healthyFiles(), ...markerFile(behind) } }),
    );
    expect(byCheck.get("secret-generation")?.status).toBe("warn");
    expect(byCheck.get("secret-generation")?.remedy).toContain("collie pack rotate");
    expect(code).toBe(EXIT.OK);
    expect(PACK.secretGeneration).toBe(1);
  });

  test("member-reach: an unreachable member is an error naming `collie reconnect`", async () => {
    const { code, byCheck } = await findings(
      harness(LEAD, [new Error("connection refused")], { files: { ...healthyFiles(), ...markerFile(LEAD) } }),
    );
    const f = byCheck.get("member-reach");
    expect(f?.status).toBe("error");
    expect(f?.detail).toContain("laptop");
    expect(f?.remedy).toContain("collie reconnect");
    expect(code).toBe(EXIT.FAIL);
  });

  test("member-versions: skew WARNS naming both versions — §7.1 refuses nothing, so nor does this", async () => {
    const { code, byCheck } = await findings(
      harness(LEAD, [hello({ version: "1.0.0-alpha.9" })], {
        files: { ...healthyFiles(), ...markerFile(LEAD) },
      }),
    );
    const f = byCheck.get("member-versions");
    expect(f?.status).toBe("warn");
    expect(f?.detail).toContain("1.0.0-alpha.9");
    expect(f?.detail).toContain("1.0.0-alpha.12");
    expect(f?.remedy).toContain("update the older machine");
    expect(code).toBe(EXIT.OK);
  });

  test("member-versions: a member that reported none renders as pre-amendment, not as an error", async () => {
    const { code, byCheck } = await findings(
      harness(LEAD, [hello({ version: null })], { files: { ...healthyFiles(), ...markerFile(LEAD) } }),
    );
    const f = byCheck.get("member-versions");
    expect(f?.status).toBe("ok");
    expect(f?.detail).toContain("pre-1.0.0-alpha.12 (not reported)");
    expect(f?.detail).toContain("laptop");
    expect(code).toBe(EXIT.OK);
  });

  test("member-versions: same version everywhere is one quiet ✓", async () => {
    const { byCheck } = await findings(
      harness(LEAD, [hello()], { files: { ...healthyFiles(), ...markerFile(LEAD) } }),
    );
    expect(byCheck.get("member-versions")?.status).toBe("ok");
    expect(byCheck.get("member-versions")?.detail).toContain("1.0.0-alpha.12");
  });
});

// ── The terminal seam ────────────────────────────────────────────────────────
// Everything above this line runs with no `ui`, which is the point: absent is the default, and the
// plain lines every assertion in this file pins are what a pipe, a test and `--plain` all get.
describe("the terminal renderer", () => {
  test("with a `ui`, the findings go to it and nothing is printed", async () => {
    const { ui, views } = fakeUi();
    const h = harness(null);
    expect(await cmdDoctor({ ...h.deps, ui }, [])).toBe(EXIT.OK);
    expect(h.io.stdout).toEqual([]);
    expect(views).toHaveLength(1);
    // The same findings, not a re-derived summary of them.
    expect(views[0]!.local.map((f) => f.check)).toEqual((await plainFindings()).map((f) => f.check));
    expect(views[0]!.pack).toEqual([]);
    expect(views[0]!.packNote[0]).toContain("not in a pack");
  });

  test("`--json` outranks the renderer — a script's stdout is never a drawing", async () => {
    const { ui, views } = fakeUi();
    const h = harness(null);
    expect(await cmdDoctor({ ...h.deps, ui }, ["--json"])).toBe(EXIT.OK);
    expect(views).toEqual([]);
    expect(JSON.parse(h.io.stdout.join("\n"))).toBeArray();
  });
});

/** The findings an equivalent plain run reports, read back out of `--json`. */
async function plainFindings(): Promise<Finding[]> {
  const fresh = harness(null);
  await cmdDoctor(fresh.deps, ["--json"]);
  return JSON.parse(fresh.io.stdout.join("\n")) as Finding[];
}
