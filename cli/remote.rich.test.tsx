import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { AuditLog, type AuditEntry } from "../bridge/audit.ts";
import { PACK_PROTOCOL_VERSION } from "../bridge/pack/enrollment.ts";
import { leadStore, material, member, T0 } from "../bridge/pack/fixtures.ts";
import { serializeTrustStore, TrustStore, type TrustStoreIo } from "../bridge/pack/trust-store.ts";
import { capture, context, fakeExec, fakeFiles, ROOT } from "./fakes.ts";
import { EXIT, type Io } from "./io.ts";
import type { AddSurface, Ui } from "./render.ts";
import { cmdPackAdd, type PackAddDeps, type RemoteResult } from "./remote.ts";
import { createAddStore, PackAdd, type AddStore } from "./ui/pack-add.tsx";

// `pack add` on the RICH path: the same fake transport the plain suite uses, driven through a real
// ink render.
//
// What these tests are for is the rule in `cli/render.ts` — the surface owns every byte while it is
// mounted. So the `Io` handed to `cmdPackAdd` here is one that THROWS if anything writes through it,
// and the run is expected to finish anyway: every line has to have gone through the surface. The
// frames are then asserted for the leg progression, the condensed restart row and the prompt, which
// is the part a golden file cannot pin.

// ── The fakes (a slimmer cousin of `cli/remote.test.ts`'s, deliberately not shared: that suite pins
// the plain lines and must stay untouched by anything this file needs) ───────

type Leg = "probe" | "install" | "configure" | "membership" | "enroll";

function legOf(script: string): Leg {
  if (script.includes("collie-probe:")) return "probe";
  if (script.includes("collie-install:")) return "install";
  if (script.includes("collie-configure:")) return "configure";
  if (script.includes("pack status --no-probe")) return "membership";
  if (script.includes("'join'")) return "enroll";
  throw new Error(`unrecognised leg script:\n${script}`);
}

const COMMIT = "abc123def4567890abc123def4567890abc123de";
const VERSION = "1.2.3";
const REMOTE_HOME = "/home/pat";
const REMOTE_CHECKOUT = `${REMOTE_HOME}/.collie`;

const PROBE_DEFAULTS: Record<string, string> = {
  home: REMOTE_HOME,
  git: "/usr/bin/git",
  bun: "/home/pat/.bun/bin/bun",
  herdr: "/usr/local/bin/herdr",
  configdir: "/home/pat/.config/herdr/plugins/config/herdr.collie",
  envhost: "",
  envport: "",
  checkout: "",
  commit: "",
  branch: "",
  dirty: "",
  dirtyfiles: "",
  version: "",
  address: "100.64.0.9",
  port: "free",
};

function probeOut(over: Record<string, string> = {}): string {
  const all = { ...PROBE_DEFAULTS, ...over };
  return [...Object.entries(all).map(([k, v]) => `collie-probe:${k}=${v}`), "collie-probe:probe=ok", ""].join("\n");
}

const SOLO_STATUS = "mode: solo — this collie is not in a pack (no trust store, or an empty one).";

/** An `Io` that must never be reached: on the rich path, the surface is the only writer. */
function forbiddenIo(): Io {
  const refuse = (line: string): never => {
    throw new Error(`something wrote to the terminal while the surface was mounted: ${line}`);
  };
  return { out: refuse, err: refuse };
}

interface RichHarness {
  deps: PackAddDeps;
  store: AddStore;
  restarts: number;
  closes: number;
}

function harness(opts: {
  probe?: Record<string, string>;
  answers?: Partial<Record<Leg, Partial<RemoteResult>>>;
  reachable?: boolean;
  io?: Io;
}): RichHarness {
  const store = createAddStore();
  const surface: AddSurface = {
    io: store.io,
    emit: store.emit,
    confirm: store.confirm,
    prompt: store.prompt,
    // The mount and the unmount belong to the test's own `render` — everything else is real.
    close: async () => {
      state.closes += 1;
    },
  };
  const ui: Ui = {
    doctor: () => Promise.resolve(),
    status: () => Promise.resolve(),
    packMembers: () => Promise.resolve(),
    packAdd: () => surface,
  };
  const state = { restarts: 0, closes: 0 };

  let contents: string | null = serializeTrustStore(leadStore());
  const storeIo: TrustStoreIo = {
    read: async () => contents,
    write: async (_p, d) => {
      contents = d;
    },
  };
  const audit: AuditEntry[] = [];

  const deps: PackAddDeps = {
    ctx: context({ COLLIE_PACK_TIMEOUT_MS: "60000" }),
    io: opts.io ?? forbiddenIo(),
    ui,
    exec: fakeExec({
      answers: [
        [`git -C ${ROOT} rev-parse HEAD`, { stdout: `${COMMIT}\n` }],
        [`git -C ${ROOT} status --porcelain`, { stdout: "" }],
        [`git -C ${ROOT} show ${COMMIT}:herdr-plugin.toml`, { stdout: `version = "${VERSION}"\n` }],
        ["tailscale status --json", { stdout: JSON.stringify({ Self: { DNSName: "desk.tail.ts.net." } }) }],
      ],
    }),
    files: fakeFiles(),
    store: new TrustStore("/state", storeIo),
    audit: new AuditLog((l: string) => void audit.push(JSON.parse(l) as AuditEntry), () => T0),
    fetch: async () =>
      opts.reachable === false
        ? Promise.reject(new Error("connection refused"))
        : new Response(JSON.stringify({ protocol: PACK_PROTOCOL_VERSION, member: "nas", version: VERSION }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-pack-protocol": String(PACK_PROTOCOL_VERSION),
              "x-pack-member": "nas",
            },
          }),
    now: () => T0,
    random: (() => {
      let i = 0;
      return () => `r${++i}`;
    })(),
    mintIdentity: () => Promise.resolve(material("fresh")),
    readStdin: () => Promise.resolve(""),
    restart: () => {
      state.restarts += 1;
      return Promise.resolve(EXIT.OK);
    },
    serve: () => Promise.resolve(EXIT.OK),
    unserve: () => EXIT.OK,
    clearNotifications: () => Promise.resolve(),
    remote: () => ({
      run: async (script) => {
        const leg = legOf(script);
        const stdout =
          leg === "probe"
            ? probeOut(opts.probe)
            : leg === "membership"
              ? SOLO_STATUS
              : leg === "install"
                ? `collie-install:root=${REMOTE_CHECKOUT}\ncollie-install:version=${VERSION}`
                : "";
        return { code: 0, stdout, stderr: "", spawned: true, ...(opts.answers?.[leg] ?? {}) };
      },
      close: () => {},
    }),
    confirm: () => {
      throw new Error("the rich path must answer inside the app, never through Bun's confirm()");
    },
    prompt: () => {
      throw new Error("the rich path must answer inside the app, never through Bun's prompt()");
    },
    gitBundle: () => Promise.resolve("QkFTRTY0LWJ1bmRsZQ=="),
    reload: () => Promise.resolve(leadStore({ peers: [member({ memberId: "nas", address: "100.64.0.9:8787" })] })),
  };

  return {
    deps,
    store,
    get restarts() {
      return state.restarts;
    },
    get closes() {
      return state.closes;
    },
  };
}

/** Frames carry SGR escapes; the assertions are about words, so read them without. */
const plainText = (frame: string | undefined): string =>
  // eslint-disable-next-line no-control-regex
  (frame ?? "").replace(/\[[0-9;]*m/g, "");

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── The flows ────────────────────────────────────────────────────────────────

describe("pack add, drawn", () => {
  test("a full run: four legs, a confirm answered in the app, one row per restart, a green verdict", async () => {
    const h = harness({
      // An existing checkout at another commit is what raises the replace question.
      probe: { checkout: REMOTE_CHECKOUT, commit: "0".repeat(40), version: "1.0.0", dirty: "no" },
    });
    const app = render(<PackAdd store={h.store} />);
    try {
      const run = cmdPackAdd(h.deps, ["nas.example"]);
      await waitFor(() => h.store.state().question !== null, "the replace question");
      expect(plainText(app.lastFrame())).toContain("replace it with 1.2.3");
      expect(plainText(app.lastFrame())).toContain("y / N");
      app.stdin.write("y");

      expect(await run).toBe(EXIT.OK);
      await waitFor(() => plainText(app.lastFrame()).includes("is a member of"), "the verdict frame");


      const frame = plainText(app.lastFrame());
      // The title, the probe's facts as pairs, and all four legs with their details.
      expect(frame).toContain("pack add nas.example");
      expect(frame).toContain("/usr/local/bin/herdr");
      expect(frame).toContain("100.64.0.9:8787 (what this lead will dial)");
      for (const leg of ["probe", "install", "configure", "enroll"]) expect(frame).toContain(leg);
      expect(frame).toContain(`1.2.3 at ${REMOTE_CHECKOUT}`);
      expect(frame).toContain("written to /home/pat/.config/herdr/plugins/config/herdr.collie/.env");
      expect(frame).toContain("nas.example answered the invite");
      // Both restarts condensed to one row each, and the banner block nowhere in sight.
      expect(h.restarts).toBe(2);
      expect(frame.match(/↻ bridge restarted \(collie\)/g)?.length).toBe(2);
      expect(frame).not.toContain("Collie is running");
      // The verdict is the last thing on screen.
      expect(frame.trimEnd().endsWith('"nas" is a member of "the herd" and answered at 100.64.0.9:8787')).toBe(true);
      // A spinner never survives the run.
      expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      expect(h.closes).toBe(1);
    } finally {
      app.unmount();
    }
  });

  test("a failing install: the leg is marked ✗, its error sits under it, and the verdict is red", async () => {
    const h = harness({
      answers: { install: { code: 24, stderr: "error: the build failed on this machine\n" } },
    });
    const app = render(<PackAdd store={h.store} />);
    try {
      expect(await cmdPackAdd(h.deps, ["nas.example"])).toBe(EXIT.FAIL);
      await waitFor(() => plainText(app.lastFrame()).includes("did not finish"), "the failure verdict");

      const frame = plainText(app.lastFrame());
      expect(frame).toContain("✗");
      expect(frame).toContain("error: the install failed on nas.example — error: the build failed on this machine");
      expect(frame).toContain("pack add did not finish (exit 1)");
      // The legs after the failure never ran, so they never claim to have.
      expect(frame).not.toContain("written to");
      expect(frame).not.toContain("answered the invite");
      expect(h.restarts).toBe(0);
    } finally {
      app.unmount();
    }
  });

  test("Enter is No: the default the `[y/N]` prompt had survives the rendering change", async () => {
    const h = harness({
      probe: { checkout: REMOTE_CHECKOUT, commit: "0".repeat(40), version: "1.0.0", dirty: "no" },
    });
    const app = render(<PackAdd store={h.store} />);
    try {
      const run = cmdPackAdd(h.deps, ["nas.example"]);
      await waitFor(() => h.store.state().question !== null, "the replace question");
      app.stdin.write("\r");
      expect(await run).toBe(EXIT.STATE);
      const frame = plainText(app.lastFrame());
      expect(frame).toContain("error: left alone — nothing was installed, configured or enrolled.");
    } finally {
      app.unmount();
    }
  });
});

// ── The seam itself ──────────────────────────────────────────────────────────

describe("which renderer pack add gets", () => {
  test("no `ui` means the plain lines, through the caller's own Io", async () => {
    const h = harness({});
    const io = capture();
    const code = await cmdPackAdd({ ...h.deps, ui: null, io }, ["nas.example"]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout).toContain("probing nas.example…");
    expect(io.stdout.some((l) => l.startsWith("✓ install"))).toBe(true);
  });

  test("a `Ui` without the streaming surface also stays plain — the three one-shot verbs are enough", async () => {
    const h = harness({});
    const io = capture();
    const oneShot = {
      doctor: () => Promise.resolve(),
      status: () => Promise.resolve(),
      packMembers: () => Promise.resolve(),
    };
    const code = await cmdPackAdd({ ...h.deps, ui: oneShot, io }, ["nas.example"]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout).toContain("probing nas.example…");
  });

  test("with the surface, NOTHING reaches the caller's Io — not even a nested restart", async () => {
    // `forbiddenIo` throws on any write, so the run finishing at all is the assertion.
    const h = harness({});
    const app = render(<PackAdd store={h.store} />);
    try {
      expect(await cmdPackAdd(h.deps, ["nas.example"])).toBe(EXIT.OK);
    } finally {
      app.unmount();
    }
  });
});
