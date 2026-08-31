import { describe, expect, test } from "bun:test";

import { PACK_PROTOCOL_VERSION } from "../bridge/pack/enrollment.ts";
import { leadStore, member, PACK, peerStore, T0 } from "../bridge/pack/fixtures.ts";
import { markerFor } from "../bridge/pack/staleness.ts";
import { serializeTrustStore, TrustStore, type TrustStoreData, type TrustStoreIo } from "../bridge/pack/trust-store.ts";
import { fakeBeaconReader, FAKE_BEACON_NOW, type FakeBeacon } from "../bridge/beacon/fake.ts";
import { BEACON_SCHEMA_VERSION } from "../bridge/beacon/types.ts";
import type { JsonObject } from "../bridge/json.ts";
import { BEACON_HOOKS } from "./beacon.ts";
import { cmdDoctor, type DoctorDeps, type Finding } from "./doctor.ts";
import { HOOK_MARKER, HOOK_MARKER_PREFIX } from "./hooks.ts";
import type { LinkProbe } from "./link.ts";
import type { DoctorView, Ui } from "./render.ts";
import {
  capture,
  context,
  CONFIG,
  fakeExec,
  fakeFiles,
  fakeLinkFs,
  HOME,
  ROOT,
  type Scripted,
  type SeededFiles,
  STATE,
} from "./fakes.ts";
import { EXIT } from "./io.ts";

// `collie doctor`, against fakes for every seam. Like cli/pack.test.ts, NOTHING here reaches a
// service manager, a tailnet, a real trust store or a network — and unlike it, there is nothing to
// reach even in principle: `DoctorDeps` names no verb that could change something, so a test that
// wanted to assert "doctor wrote nothing" is asserting a type, not a behaviour. It is asserted
// anyway (the fake filesystem records every write), because the read-only contract is the reason
// this verb is safe to run on a machine that is already misbehaving.

const HANDLER = `${CONFIG}/tailscale-managed-handler`;
/** The name `collie link` publishes, and the directory it lives in (ADR 0021). */
const LINK_DIR = `${HOME}/.local/bin`;
const LINK_AT = `${LINK_DIR}/collie`;
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

/** `herdr integration status` on a host where every journalled agent's hook is current (issue #137). */
const INTEGRATION_OK = [
  "claude: installed (/home/pat/.claude/hooks/herdr-agent-state.sh)",
  "codex: installed (/home/pat/.codex/herdr-agent-state.sh)",
  "pi: installed (/home/pat/.pi/agent/extensions/herdr-agent-state.ts)",
  "opencode: installed (/home/pat/.config/opencode/plugins/herdr-agent-state.js)",
  "grok: installed (/home/pat/.grok/hooks/herdr-agent-state.sh)",
].join("\n");

const HEALTHY_ANSWERS: Scripted["answers"] = [
  ["herdr --version", { stdout: "herdr 0.8.2\n" }],
  // A healthy checkout can say where it came from: `update` asserts `origin` against the configured
  // update source before it fetches, so an origin-less checkout is a real (reported) problem.
  [`git -C ${ROOT} remote get-url origin`, { stdout: "https://github.com/AltanS/collie.git\n" }],
  [`git -C ${ROOT} symbolic-ref --short HEAD`, { stdout: "main\n" }],
  ["herdr integration status", { stdout: INTEGRATION_OK }],
  ["tailscale status --json", { stdout: JSON.stringify({ Self: { DNSName: "laptop.tail.ts.net." } }) }],
  ["tailscale serve status --json", { stdout: SERVE_OK }],
  ...netmapAnswers(NETMAP_OPEN),
];

/**
 * The files a healthy install has: a built bundle, a Herdr socket, an ownership record — and the
 * agent's own settings carrying a current emitter entry pinned to a binary that exists.
 *
 * The emitter is in the BASELINE so the contract test above it can go on asserting that a healthy
 * install warns about nothing. Its absence is a warn rather than an error (a Herdr operator never
 * installs one), and that case is seeded explicitly by the tests that are about it.
 */
function healthyFiles(): SeededFiles {
  return {
    [SETTINGS]: settingsWith(hookCommand(OWN_BINARY)),
    [OWN_BINARY]: "#!/bin/sh",
    [`${ROOT}/web/dist/index.html`]: "<!doctype html>",
    [`${ROOT}/web/dist/assets/app.js`]: "//",
    [`${ROOT}/web/dist/build-info.json`]: JSON.stringify({ version: "1.0.0-alpha.12" }),
    [SOCKET]: "",
    [HANDLER]: `https:443|${HOSTPORT}|${PROXY}\n`,
    // One journal root with something in it. In the BASELINE for the same reason the emitter is:
    // `journal-roots` warns when no root is there at all, and the contract test above asserts a
    // healthy install warns about nothing (issue #137).
    [`${HOME}/.claude/projects/-home-pat-repo/9f3c.jsonl`]: "{}",
  };
}

interface Harness {
  deps: DoctorDeps;
  io: ReturnType<typeof capture>;
  files: ReturnType<typeof fakeFiles>;
  requests: string[];
  /** Every `<tool> <args…>` this run spawned — how the mux probe's ONE invocation is pinned. */
  calls: string[];
}

/**
 * Build a harness. `initial` is the trust store on disk (`null` = never enrolled), `replies` answers
 * each `hello` in order, and `over` replaces any seam or the seeded filesystem.
 */
/** What {@link fakeUi} hands back: the renderer seam, and the views it was handed. */
interface FakeUi {
  ui: Ui;
  views: DoctorView[];
}

/**
 * A recording stand-in for the terminal renderer. Its presence is the whole of the seam: `doctor`
 * hands it the findings it would otherwise have formatted, and prints nothing itself.
 */
function fakeUi(): FakeUi {
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
    /** What is at `~/.local/bin/collie`; absent — nothing linked — is the default. */
    link?: Record<string, LinkProbe>;
    /** The beacon directory this host has right now; empty is the default. */
    beacons?: FakeBeacon[];
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
  const exec = fakeExec({ answers: over.answers ?? HEALTHY_ANSWERS, absent: over.absent });
  const requests: string[] = [];
  let n = 0;
  return {
    deps: {
      // As in cli/pack.test.ts: the peer client races the fake fetch against a REAL timer, so the
      // budget is set far above anything this process could stall for.
      ctx: context({ COLLIE_PACK_TIMEOUT_MS: "60000", ...over.env }, { socket: SOCKET }),
      io: out,
      exec,
      files,
      link: fakeLinkFs(over.link),
      store: new TrustStore(STATE, io),
      fetch: async (url) => {
        requests.push(url);
        const reply = replies[n++];
        if (reply === undefined) return hello();
        if (reply instanceof Error) throw reply;
        return reply;
      },
      // An in-memory beacon directory (bridge/beacon/fake.ts): no state directory, no live process,
      // and — the point of the seam — nothing `doctor` could write even if it tried.
      beacons: fakeBeaconReader(over.beacons ?? []),
      now: () => T0,
    },
    io: out,
    files,
    requests,
    calls: exec.calls,
  };
}

/** §5's body: the two required fields, and the version a member may or may not name. */
interface HelloBody {
  protocol: number;
  member: string;
  version?: string;
}

/** A `hello` answer: §6's two headers, the optional §5 `version`, and an HTTP `Date` the clock reads. */
function hello(
  over: { version?: string | null; date?: number | null; memberId?: string } = {},
): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "x-pack-protocol": String(PACK_PROTOCOL_VERSION),
    "x-pack-member": over.memberId ?? "laptop",
  });
  if (over.date !== null) headers.set("date", new Date(over.date ?? T0).toUTCString());
  const version = over.version === undefined ? "1.0.0-alpha.12" : over.version;
  const body: HelloBody = { protocol: PACK_PROTOCOL_VERSION, member: over.memberId ?? "laptop" };
  if (version !== null) body.version = version;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

/** A `--json` run read back: its exit code, its findings in order, and the same keyed by check. */
interface JsonRun {
  code: number;
  byCheck: Map<string, Finding>;
  raw: Finding[];
}

/** The `--json` findings, keyed by check. Every assertion below reads the contract, not the prose. */
async function findings(h: Harness): Promise<JsonRun> {
  const code = await cmdDoctor(h.deps, ["--json"]);
  // SAFETY: `--json` prints exactly the `Finding[]` `cmdDoctor` serialised, on stdout, and nothing
  // else — which is what the "prints an array on stdout and nothing else" test below pins. A run
  // that printed anything else fails to parse here, which is the failure this suite wants.
  const raw = JSON.parse(h.io.stdout.join("\n")) as Finding[];
  return { code, byCheck: new Map(raw.map((f) => [f.check, f])), raw };
}

const LEAD = leadStore({ peers: [member({ memberId: "laptop" })] });

/** A boot marker that matches a store exactly — the "the running bridge holds this roster" case. */
const markerFile = (data: TrustStoreData): SeededFiles => ({
  [`${STATE}/pack-runtime.json`]: JSON.stringify(markerFor(data, T0, 42)),
});

/** A seed with one path taken out of it — the "that file is simply not there" cases. */
function without(files: SeededFiles, path: string): SeededFiles {
  const rest = { ...files };
  delete rest[path];
  return rest;
}

// ── The contract ─────────────────────────────────────────────────────────────

describe("collie doctor — the contract", () => {
  test("a healthy solo install passes everything it can run, and exits 0", async () => {
    const h = harness(null);
    const { code, byCheck, raw } = await findings(h);
    expect(code).toBe(EXIT.OK);
    expect([...byCheck.keys()]).toEqual([
      "web-dist",
      "path-link",
      "install",
      "update-source",
      "herdr-socket",
      "bind",
      "bind-wildcard",
      "acl",
      "front-door",
      "mux",
      "beacon-hooks-claude",
      "beacons",
      "herdr-version",
      "integration-claude",
      "integration-codex",
      "integration-grok",
      "integration-opencode",
      "integration-pi",
      "hook-python3",
      "agent-sessions",
      "journal-roots",
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
      expect(/`collie |`herdr |`tailscale |`timedatectl |`python3|`ls |COLLIE_/.test(line)).toBe(true);
    }
  });

  test("warnings alone exit 0; one error is enough to exit 1", async () => {
    // The hatch rides along because a wildcard bind on a SOLO collie is an ERROR without it (the
    // bridge refuses to start) — and this test needs a run whose worst finding is a warning.
    const warned = harness(null, [], {
      env: { COLLIE_HOST: "0.0.0.0", COLLIE_ALLOW_NON_LOOPBACK_BIND: "1" },
    });
    const warnRun = await findings(warned);
    expect(warnRun.byCheck.get("bind-wildcard")?.status).toBe("warn");
    expect(warnRun.raw.some((f) => f.status === "error")).toBe(false);
    expect(warnRun.code).toBe(EXIT.OK);

    const broken = harness(null, [], { files: without(healthyFiles(), SOCKET) });
    const badRun = await findings(broken);
    expect(badRun.byCheck.get("herdr-socket")?.status).toBe("error");
    expect(badRun.code).toBe(EXIT.FAIL);
  });

  test("--json prints an array on stdout and nothing else", async () => {
    const h = harness(LEAD, [hello()], { files: { ...healthyFiles(), ...markerFile(LEAD) } });
    const code = await cmdDoctor(h.deps, ["--json"]);
    expect(code).toBe(EXIT.OK);
    expect(h.io.stderr).toEqual([]);
    // SAFETY: this test IS the check that stdout holds nothing but that array — `Array.isArray` on
    // the next line and the key/status assertions below are what the assertion is being trusted for.
    const parsed = JSON.parse(h.io.stdout.join("\n")) as Finding[];
    expect(Array.isArray(parsed)).toBe(true);
    for (const f of parsed) {
      expect(Object.keys(f).toSorted()).toEqual(["check", "detail", "remedy", "status"]);
      expect(["ok", "warn", "error", "skipped"]).toContain(f.status);
    }
  });

  test("it writes nothing — no file, no store, no record", async () => {
    const h = harness(LEAD, [hello()], { files: { ...healthyFiles(), ...markerFile(LEAD) } });
    const before = new Map(h.files.entries);
    await cmdDoctor(h.deps, []);
    expect([...h.files.entries.keys()].toSorted()).toEqual([...before.keys()].toSorted());
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
        files: without({ ...healthyFiles(), ...markerFile(peer) }, HANDLER),
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

  // ── path-link (ADR 0021) ───────────────────────────────────────────────────
  // Reported, never repaired: `doctor` holds a `LinkReader`, which has no way to publish or remove a
  // name. Not being linked is an ordinary state, so it is `ok`; a name that reaches somewhere else is
  // what earns a warning.
  test("path-link: not linked is ok, and names the verb that would publish it", async () => {
    const { code, byCheck } = await findings(harness(null));
    const f = byCheck.get("path-link");
    expect(f?.status).toBe("ok");
    expect(f?.detail).toContain("not linked");
    expect(f?.detail).toContain(LINK_AT);
    expect(code).toBe(EXIT.OK);
  });

  test("path-link: linked here, with the directory on PATH, is ok", async () => {
    const h = harness(null, [], {
      env: { PATH: `/usr/bin:${LINK_DIR}` },
      link: { [LINK_AT]: { kind: "symlink", target: `${ROOT}/bin/collie` } },
    });
    const f = (await findings(h)).byCheck.get("path-link");
    expect(f?.status).toBe("ok");
    expect(f?.detail).toContain("this checkout");
  });

  test("path-link: linked here but the directory is off PATH warns — the shell cannot find it", async () => {
    const h = harness(null, [], {
      env: { PATH: "/usr/bin" },
      link: { [LINK_AT]: { kind: "symlink", target: `${ROOT}/bin/collie` } },
    });
    const f = (await findings(h)).byCheck.get("path-link");
    expect(f?.status).toBe("warn");
    expect(f?.remedy).toContain(LINK_DIR);
  });

  test("path-link: another checkout's link warns, naming the checkout a bare `collie` reaches", async () => {
    const h = harness(null, [], {
      link: { [LINK_AT]: { kind: "symlink", target: "/opt/collie-v1/bin/collie" } },
    });
    const f = (await findings(h)).byCheck.get("path-link");
    expect(f?.status).toBe("warn");
    expect(f?.detail).toContain("/opt/collie-v1/bin/collie");
    expect(f?.remedy).toContain("collie link");
  });

  test("path-link: anything else at the name warns and is left alone", async () => {
    const h = harness(null, [], { link: { [LINK_AT]: { kind: "other", what: "a regular file" } } });
    const f = (await findings(h)).byCheck.get("path-link");
    expect(f?.status).toBe("warn");
    expect(f?.detail).toContain("a regular file");
    expect(f?.detail).toContain("will not touch it");
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
        files: without({ ...healthyFiles(), ...markerFile(peer) }, HANDLER),
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
    // With the hatch set, so the only thing this run has to say about the bind is the warning.
    const { code, byCheck } = await findings(
      harness(null, [], { env: { COLLIE_HOST: "", COLLIE_ALLOW_NON_LOOPBACK_BIND: "1" } }),
    );
    expect(byCheck.get("bind-wildcard")?.status).toBe("warn");
    expect(code).toBe(EXIT.OK);
  });

  // The gate main brought (#129) and the pack carve-out that keeps it honest: a wide bind stops a
  // SOLO collie from starting at all, so doctor says the same thing the bridge would — while a peer
  // binds wide by construction and hears only the wildcard warning (ADR 0013).
  test("bind: a wide bind is an ERROR on solo, cleared by the hatch, and never one on a peer", async () => {
    const solo = await findings(harness(null, [], { env: { COLLIE_HOST: "10.0.0.4" } }));
    expect(solo.byCheck.get("bind")?.status).toBe("error");
    expect(solo.byCheck.get("bind")?.remedy).toContain("COLLIE_ALLOW_NON_LOOPBACK_BIND=1");
    expect(solo.code).toBe(EXIT.FAIL);

    const hatched = await findings(
      harness(null, [], { env: { COLLIE_HOST: "10.0.0.4", COLLIE_ALLOW_NON_LOOPBACK_BIND: "1" } }),
    );
    expect(hatched.byCheck.get("bind")?.status).toBe("ok");
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

  // ── install / update-source (M14/01 §4.3) ──────────────────────────────────
  // Reported, never repaired, from the SAME classifier `collie update` forks on — so the two verbs
  // cannot disagree about what they are looking at.

  test("install: a linked clone names its branch and its origin", async () => {
    const f = (await findings(harness(null))).byCheck.get("install");
    expect(f?.status).toBe("ok");
    expect(f?.detail).toContain("linked clone");
    expect(f?.detail).toContain("branch main");
    expect(f?.detail).toContain("AltanS/collie");
  });

  test("install: a Herdr-managed checkout is named as one", async () => {
    const h = harness(null, [], {
      answers: [...HEALTHY_ANSWERS, [`git -C ${ROOT} symbolic-ref -q HEAD`, { code: 1 }]],
    });
    expect((await findings(h)).byCheck.get("install")?.detail).toContain("Herdr-managed checkout");
  });

  test("install: an install it cannot name warns and points at the docs", async () => {
    const h = harness(null, [], {
      answers: [...HEALTHY_ANSWERS, [`git -C ${ROOT} rev-parse --git-dir`, { code: 128 }]],
    });
    const { byCheck, code } = await findings(h);
    expect(byCheck.get("install")?.status).toBe("warn");
    expect(byCheck.get("install")?.detail).toContain("cannot tell how this Collie was installed");
    expect(byCheck.get("install")?.remedy).toContain("docs/install.md");
    // A warning, never an error: an install doctor cannot name still runs.
    expect(code).toBe(EXIT.OK);
  });

  test("update-source: an origin that is not the update source is an ERROR naming the fork docs", async () => {
    const h = harness(null, [], {
      answers: [
        ...HEALTHY_ANSWERS.filter(([prefix]) => !prefix.includes("remote get-url")),
        [`git -C ${ROOT} remote get-url origin`, { stdout: "git@github.com:youngsecurity/collie.git\n" }],
      ],
    });
    const { byCheck, code } = await findings(h);
    const f = byCheck.get("update-source");
    expect(f?.status).toBe("error");
    expect(f?.detail).toContain("youngsecurity/collie");
    expect(f?.remedy).toContain("docs/upgrading.md");
    expect(code).toBe(EXIT.FAIL);
  });

  test("update-source: a fork the operator chose is a warning, not a failure", async () => {
    const h = harness(null, [], {
      env: { COLLIE_UPDATE_REPO: "youngsecurity/collie" },
      answers: [
        ...HEALTHY_ANSWERS.filter(([prefix]) => !prefix.includes("remote get-url")),
        [`git -C ${ROOT} remote get-url origin`, { stdout: "git@github.com:youngsecurity/collie.git\n" }],
      ],
    });
    const { byCheck, code } = await findings(h);
    expect(byCheck.get("update-source")?.status).toBe("warn");
    expect(byCheck.get("update-source")?.detail).toContain("COLLIE_UPDATE_REPO");
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

  test("member-reach: a member that answers `hello` and then starves is an error about the BUDGET", async () => {
    // `hello` runs on the patient budget, every real read on the strict clamped one — so a link whose
    // handshake outprices the poll used to answer the probe while the phone got 503s, and this check
    // printed ✓ over it. Both questions are asked now, and the remedy names the knobs, not `reconnect`.
    const { code, byCheck } = await findings(
      harness(LEAD, [hello(), new Error("timed out after 1200ms")], {
        files: { ...healthyFiles(), ...markerFile(LEAD) },
      }),
    );
    const f = byCheck.get("member-reach");
    expect(f?.status).toBe("error");
    expect(f?.detail).toContain("served no data");
    expect(f?.remedy).toContain("COLLIE_PACK_TIMEOUT_MS");
    expect(f?.remedy).toContain("COLLIE_POLL_MS");
    expect(f?.remedy).not.toContain("collie reconnect");
    expect(code).toBe(EXIT.FAIL);
  });

  // F21: the peer's side of the same check. `/pack/v1/snapshot` is not on the closed peer → lead
  // route set (§8.6), so the only answer the second question can get is §8.1's bare 401 — which this
  // check reported as "answered but served no data", with the budget remedy, on a healthy pack.
  test("lead-reach: a peer asks its lead `hello` and nothing else", async () => {
    const peer = peerStore();
    const h = harness(peer, [hello({ memberId: "desk" })], {
      env: { COLLIE_HOST: "laptop.tail.ts.net" },
      files: without({ ...healthyFiles(), ...markerFile(peer) }, HANDLER),
    });
    const { byCheck } = await findings(h);
    expect(h.requests).not.toContain("https://desk.example:8787/pack/v1/snapshot");
    const f = byCheck.get("lead-reach");
    expect(f?.status).toBe("ok");
    expect(f?.detail).toContain("answered `hello`");
    expect(f?.detail).not.toContain("served a snapshot");
  });

  test("member-reach: a healthy member reports both answers, and the data half is a REAL request", async () => {
    const h = harness(LEAD, [hello(), hello()], { files: { ...healthyFiles(), ...markerFile(LEAD) } });
    const { byCheck } = await findings(h);
    expect(byCheck.get("member-reach")?.status).toBe("ok");
    expect(byCheck.get("member-reach")?.detail).toContain("served a snapshot");
    expect(h.requests).toEqual([
      "https://laptop.example:8787/pack/v1/hello",
      "https://laptop.example:8787/pack/v1/snapshot",
      // The history section's one GET of THIS bridge's own snapshot (issue #137), on the same seam.
      "http://127.0.0.1:8787/api/snapshot",
    ]);
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
    expect(f?.remedy).toContain("collie pack update");
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

// ── The agent's own hooks, and the beacons they write (M11/05) ───────────────
//
// Every case here is READ-ONLY by construction: the fake filesystem records writes, and the suite's
// existing "doctor wrote nothing" assertion covers these paths with the rest. What is asserted here
// is the tier — a missing install is a `warn` and the run still exits 0, because a Herdr operator
// will never install one.

/** The Claude settings file `hooks install claude` writes on a default host. */
const SETTINGS = `${HOME}/.claude/settings.json`;
/** The binary an install pins to when nothing is linked: this checkout's own. */
const OWN_BINARY = `${ROOT}/bin/collie`;

/** A settings document carrying our entry on every registered event, at `version`. */
function settingsWith(command: string): string {
  const hooks: JsonObject = {};
  for (const registration of BEACON_HOOKS) {
    hooks[registration.event] = [{ matcher: registration.matcher, hooks: [{ type: "command", command }] }];
  }
  return JSON.stringify({ hooks }, null, 2);
}

/** The command an install at `version` would have written, pinned to `binary`. */
const hookCommand = (binary: string, version = HOOK_MARKER): string => `${binary} beacon emit ${version}`;

/** One beacon on disk, alive or not. Markers are opaque here — this suite only counts. */
function beacon(pid: number, alive: boolean): FakeBeacon {
  return {
    alive,
    record: {
      schemaVersion: BEACON_SCHEMA_VERSION,
      harness: "claude",
      session: { kind: "id", value: `session-${String(pid)}` },
      status: "idle",
      pid,
      pidStartTime: pid * 10,
      markers: [{ namespace: "fixture", scope: "/socket", pane: `%${String(pid)}` }],
      heartbeatMs: FAKE_BEACON_NOW - 1000,
    },
  };
}

// ── What a missing install costs depends on the MULTIPLEXER ──────────────────
// Herdr names the agent from its own wire (`agentDetection`), so nobody will ever install the
// emitter there and a red line would be noise. tmux and zellij declare that capability absent, so
// the emitter is the only thing that can give them sight: without it every pane is a shell. The
// tier is read from the adapter's declaration, never from the name — these tests pin both halves.

/** Where the tmux adapter's own candidate list looks first, and what a healthy host has there. */
const TMUX_BIN = "/usr/bin/tmux";
/** Where zellij's own installer puts it — the first candidate `zellijBinaryCandidates` probes. */
const ZELLIJ_BIN = `${HOME}/.local/bin/zellij`;
const TMUX_SOCKET = "/run/collie-tmux.sock";
/** The env of a collie driving tmux on a named socket path (`-S`, per `tmuxServerArgs`). */
const ON_TMUX = { COLLIE_MUX: "tmux", COLLIE_MUX_ENDPOINT_TMUX: TMUX_SOCKET };
/** The env of a collie driving one named zellij session. */
const ON_ZELLIJ = { COLLIE_MUX: "zellij", COLLIE_MUX_ENDPOINT_ZELLIJ: "work" };

/** tmux's single joined invocation: the version on the first line, one session per line after it. */
const tmuxAnswers = (stdout: string, code = 0): Scripted["answers"] => [
  [`${TMUX_BIN} -S ${TMUX_SOCKET} display-message`, { stdout, code, stderr: code === 0 ? "" : stdout }],
  ...HEALTHY_ANSWERS!,
];
const zellijAnswers = (stdout: string, code = 0): Scripted["answers"] => [
  [`${ZELLIJ_BIN} list-sessions`, { stdout, code }],
  ...HEALTHY_ANSWERS!,
];

// ── mux ──────────────────────────────────────────────────────────────────────
// READ-ONLY like everything else here: the probe is the cheapest listing each multiplexer answers,
// and there is no argv in this check that could start a server, attach a client or create a session.

describe("mux", () => {
  test("herdr states the name and defers — the socket is `herdr-socket`'s question, asked once", async () => {
    const { byCheck, code } = await findings(harness(null, [], { env: { COLLIE_MUX: "herdr" } }));
    const finding = byCheck.get("mux")!;
    expect(finding.status).toBe("ok");
    expect(finding.detail).toBe("herdr — see herdr-socket · set by COLLIE_MUX");
    expect(finding.remedy).toBeNull();
    expect(code).toBe(EXIT.OK);
  });

  // Since M14/03 an unset COLLIE_MUX is not silently "herdr" — `collie start` probes and decides, so
  // `doctor` names the multiplexer that decision would land on, and the evidence for it.
  test("with nothing configured it names what `start` would pick, and why", async () => {
    const { byCheck, code } = await findings(harness(null));
    const finding = byCheck.get("mux")!;
    expect(finding.status).toBe("ok");
    expect(finding.detail).toContain("no COLLIE_MUX");
    expect(finding.detail).toContain(`a Herdr socket at ${SOCKET}`);
    expect(code).toBe(EXIT.OK);
  });

  test("nothing configured and nothing running is an error — that `start` refuses is the finding", async () => {
    const h = harness(null, [], { files: without(healthyFiles(), SOCKET) });
    const { byCheck } = await findings(h);
    const finding = byCheck.get("mux")!;
    expect(finding.status).toBe("error");
    expect(finding.detail).toContain("no multiplexer is running here");
    expect(finding.remedy).toContain("set COLLIE_MUX to one of herdr, tmux, zellij");
  });

  test("nothing configured and two multiplexers running is an error naming both", async () => {
    const h = harness(null, [], {
      files: { ...healthyFiles(), [TMUX_BIN]: "" },
      answers: [[`${TMUX_BIN} list-sessions`, { stdout: "work\n" }], ...HEALTHY_ANSWERS!],
    });
    const { byCheck } = await findings(h);
    const finding = byCheck.get("mux")!;
    expect(finding.status).toBe("error");
    expect(finding.detail).toContain("2 multiplexers are running");
    expect(finding.detail).toContain("herdr");
    expect(finding.detail).toContain("tmux");
  });

  test("tmux: a server that answers reports its version, its socket and its session count", async () => {
    const h = harness(null, [], {
      env: ON_TMUX,
      files: { ...healthyFiles(), [TMUX_BIN]: "" },
      answers: tmuxAnswers("3.6b\nwork\nscratch\n"),
    });
    const { byCheck, code } = await findings(h);
    const finding = byCheck.get("mux")!;
    expect(finding.status).toBe("ok");
    expect(finding.detail).toBe(`tmux 3.6b · socket ${TMUX_SOCKET} · 2 sessions · set by COLLIE_MUX`);
    // One invocation, not two: the version and the listing are `;`-joined as the adapter joins its own.
    expect(h.calls.filter((c) => c.startsWith(TMUX_BIN))).toEqual([
      `${TMUX_BIN} -S ${TMUX_SOCKET} display-message -p -F #{version} ; list-sessions -F #{session_name}`,
    ]);
    expect(code).toBe(EXIT.OK);
  });

  test("tmux: no binary is an error naming COLLIE_TMUX_BIN, and PATH is never the answer", async () => {
    const h = harness(null, [], { env: ON_TMUX, answers: HEALTHY_ANSWERS });
    const { byCheck, code } = await findings(h);
    const finding = byCheck.get("mux")!;
    expect(finding.status).toBe("error");
    expect(finding.detail).toContain("no tmux binary to run");
    expect(finding.remedy).toContain("COLLIE_TMUX_BIN");
    expect(code).toBe(EXIT.FAIL);
  });

  test("tmux: a binary but no server is an error, and the remedy never starts one for you", async () => {
    const h = harness(null, [], {
      env: ON_TMUX,
      files: { ...healthyFiles(), [TMUX_BIN]: "" },
      answers: tmuxAnswers("no server running on /run/collie-tmux.sock", 1),
    });
    const { byCheck, code } = await findings(h);
    const finding = byCheck.get("mux")!;
    expect(finding.status).toBe("error");
    expect(finding.detail).toContain("no server answered");
    expect(finding.remedy).toContain("tmux -S /run/collie-tmux.sock new -d");
    expect(finding.remedy).toContain("COLLIE_MUX_ENDPOINT_TMUX");
    expect(code).toBe(EXIT.FAIL);
  });

  test("zellij: the named session running is ok; an absent one is an error naming it", async () => {
    const files = { ...healthyFiles(), [ZELLIJ_BIN]: "" };
    const live = await findings(
      harness(null, [], { env: ON_ZELLIJ, files, answers: zellijAnswers("work\nscratch (EXITED - attach to resurrect)\n") }),
    );
    expect(live.byCheck.get("mux")?.status).toBe("ok");
    expect(live.byCheck.get("mux")?.detail).toBe(
      "zellij · session work · 1 running of 2 listed · set by COLLIE_MUX",
    );
    expect(live.code).toBe(EXIT.OK);

    const gone = await findings(harness(null, [], { env: ON_ZELLIJ, files, answers: zellijAnswers("scratch\n") }));
    const finding = gone.byCheck.get("mux")!;
    expect(finding.status).toBe("error");
    expect(finding.detail).toContain('no running zellij session called "work"');
    expect(finding.remedy).toContain("zellij -s work");
    expect(gone.code).toBe(EXIT.FAIL);
  });

  test("an unknown mux name is an error naming the ones this build drives", async () => {
    const h = harness(null, [], { env: { COLLIE_MUX: "screen" } });
    const { byCheck, code } = await findings(h);
    const finding = byCheck.get("mux")!;
    expect(finding.status).toBe("error");
    expect(finding.detail).toContain('COLLIE_MUX="screen"');
    for (const name of ["herdr", "tmux", "zellij"]) expect(finding.remedy).toContain(name);
    expect(code).toBe(EXIT.FAIL);
    // And it does NOT stack a second red line on the same typo: the hooks check reads the unknown
    // adapter optimistically, because `mux` above is already the finding about it.
    expect(byCheck.get("beacon-hooks-claude")?.status).toBe("ok");
  });
});

describe("beacon-hooks-claude", () => {
  test("under a mux that reports agents itself, no install is OK — never a red line to learn to skip", async () => {
    const h = harness(null, [], { files: without(healthyFiles(), SETTINGS) });
    const { byCheck, code } = await findings(h);
    const finding = byCheck.get("beacon-hooks-claude")!;
    expect(finding.status).toBe("ok");
    expect(finding.remedy).toBeNull();
    expect(finding.detail).toContain("herdr reports agents itself");
    expect(finding.detail).toContain("hooks installed: no");
    expect(code).toBe(EXIT.OK);
  });

  test("under a mux that does NOT, no install is an ERROR naming the install verb", async () => {
    const h = harness(null, [], {
      env: ON_TMUX,
      files: { ...without(healthyFiles(), SETTINGS), [TMUX_BIN]: "" },
      answers: tmuxAnswers("3.4\nwork\n"),
    });
    const { byCheck, code } = await findings(h);
    const finding = byCheck.get("beacon-hooks-claude")!;
    expect(finding.status).toBe("error");
    expect(finding.remedy).toContain("collie hooks install claude");
    // What it costs, in the operator's own symptoms — and what an install would pin to.
    expect(finding.detail).toContain("reads as a shell");
    expect(finding.detail).toContain("notification");
    expect(finding.detail).toContain(OWN_BINARY);
    expect(code).toBe(EXIT.FAIL);
  });

  test("an install under a blind mux is the ordinary ✓", async () => {
    const h = harness(null, [], {
      env: ON_ZELLIJ,
      files: { ...healthyFiles(), [ZELLIJ_BIN]: "" },
      answers: zellijAnswers("work\n"),
    });
    const { byCheck, code } = await findings(h);
    const finding = byCheck.get("beacon-hooks-claude")!;
    expect(finding.status).toBe("ok");
    expect(finding.detail).not.toContain("does not need");
    expect(code).toBe(EXIT.OK);
  });

  test("a current install whose binary is there is ok, with no remedy", async () => {
    const { byCheck } = await findings(harness(null));
    const finding = byCheck.get("beacon-hooks-claude")!;
    expect(finding.status).toBe("ok");
    expect(finding.remedy).toBeNull();
    expect(finding.detail).toContain(OWN_BINARY);
    // Installed anyway under Herdr is still ✓, and says out loud that nothing here needs it.
    expect(finding.detail).toContain("does not need");
  });

  test("a stale marker version is a warn whose remedy is the self-heal", async () => {
    const stale = hookCommand(OWN_BINARY, `${HOOK_MARKER_PREFIX}0`);
    const files = { ...healthyFiles(), [SETTINGS]: settingsWith(stale) };
    const { byCheck, code } = await findings(harness(null, [], { files }));
    const finding = byCheck.get("beacon-hooks-claude")!;
    expect(finding.status).toBe("warn");
    expect(finding.detail).toContain("v0");
    expect(finding.remedy).toContain("collie hooks install claude");
    expect(code).toBe(EXIT.OK);
  });

  test("a hook pinned to a path that is gone is its own warn, and names `collie link`", async () => {
    // The silent failure: valid JSON, our marker, and a command that can never run.
    const moved = `${HOME}/old-checkout/bin/collie`;
    const files = { ...healthyFiles(), [SETTINGS]: settingsWith(hookCommand(moved)) };
    const { byCheck, code } = await findings(harness(null, [], { files }));
    const finding = byCheck.get("beacon-hooks-claude")!;
    expect(finding.status).toBe("warn");
    expect(finding.detail).toContain(moved);
    expect(finding.remedy).toContain("collie link");
    expect(finding.remedy).toContain("collie hooks install claude");
    expect(code).toBe(EXIT.OK);
  });

  // The two "that is not an install" readings, asserted under a BLIND mux so the verdict is the
  // loud one — under Herdr they are `ok` for the reason above, which would prove nothing here.
  const blind = (settings: string) => ({
    env: ON_TMUX,
    files: { ...healthyFiles(), [SETTINGS]: settings, [TMUX_BIN]: "" },
    answers: tmuxAnswers("3.4\nwork\n"),
  });

  test("a settings file that is not JSON is left alone and reads as no install", async () => {
    const { byCheck } = await findings(harness(null, [], blind("{ this is not json")));
    expect(byCheck.get("beacon-hooks-claude")?.status).toBe("error");
  });

  test("somebody else's hooks are not ours — an unmarked entry installs nothing", async () => {
    const foreign = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send hi" }] }] } });
    const { byCheck } = await findings(harness(null, [], blind(foreign)));
    expect(byCheck.get("beacon-hooks-claude")?.status).toBe("error");
    expect(byCheck.get("beacon-hooks-claude")?.detail).toContain("no settings file");
  });
});

describe("beacons", () => {
  test("an empty directory with no install says so, and names the install verb", async () => {
    const { byCheck } = await findings(harness(null, [], { files: without(healthyFiles(), SETTINGS) }));
    const finding = byCheck.get("beacons")!;
    expect(finding.status).toBe("skipped");
    expect(finding.remedy).toContain("collie hooks install claude");
  });

  test("an empty directory WITH an install points at the agent, not at the installer", async () => {
    const finding = (await findings(harness(null))).byCheck.get("beacons")!;
    expect(finding.status).toBe("skipped");
    expect(finding.remedy).not.toContain("hooks install");
    expect(finding.detail).toContain("installed");
  });

  test("counts live against expired, and an expired one is never a warning", async () => {
    const beacons = [beacon(11, true), beacon(12, false), beacon(13, false)];
    const finding = (await findings(harness(null, [], { beacons }))).byCheck.get("beacons")!;
    expect(finding.status).toBe("ok");
    expect(finding.detail).toContain("1 live");
    expect(finding.detail).toContain("2 expired");
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
  // SAFETY: as in `findings` above — `--json` prints the serialised `Finding[]` and nothing else.
  return JSON.parse(fresh.io.stdout.join("\n")) as Finding[];
}
