// The server document (S1): `/` and `/pane/:paneId` answered with the app rendered from the request's
// snapshot, only for a request that may read the snapshot, and the static shell for everything else.
//
// The renderer is the shell's real one, BUNDLED here with `Bun.build` exactly as `bun build --compile`
// bundles it into the binary: the bundler compiles web-remix/ under its own tsconfig (Remix JSX, the
// `@web/*` aliases). Loaded straight by this test runtime it would not draw at all, which the last
// test pins (document.ts header).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import type { PaneWire, SnapshotResponse } from "../../types.ts";
import { loadShellRenderer, prefsFromCookie, serveDocument, type DocumentDeps, type DocumentInput, type ShellRenderer } from "./document.ts";

const TS = 1_790_000_000_000;

function pane(tag: string, n: number, over: Partial<PaneWire> = {}): PaneWire {
  return {
    paneId: `${tag}-w1:p${String(n)}`,
    workspaceId: "w1",
    workspaceLabel: `${tag}-space`,
    workspaceNumber: 1,
    tabId: "w1:t1",
    tabLabel: `${tag}-tab`,
    agent: "claude",
    status: n === 1 ? "blocked" : "working",
    cwd: "/home/you/project",
    focused: false,
    kind: "agent",
    hasSession: false,
    ...over,
  };
}

function snapshotOf(tag: string): SnapshotResponse {
  return {
    bridge: "connected",
    agents: [pane(tag, 1), pane(tag, 2)],
    shellPanes: [],
    workspaces: [{ workspaceId: "w1", number: 1, label: `${tag}-space`, focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 2 }],
    tabs: [{ tabId: "w1:t1", workspaceId: "w1", number: 1, label: `${tag}-tab`, focused: true, paneCount: 2 }],
    sessions: [{ name: "main", isPrimary: true, reachable: true, agents: 2, working: 1, blocked: 1 }],
    ts: TS,
  };
}

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="collie-base" content="/" />
    <meta name="collie-shell" content="remix" />
    <title>Collie</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
  </head>
  <body>
    <div id="boot-splash">splash</div>
  </body>
</html>
`;

let dir = "";
let renderer: ShellRenderer;
// Two web-contract tests in this suite stub a global `document` and a partial `__BUILD_INFO__` for
// the whole process (bridge/machines-web-contract.test.ts). The bridge has neither until it loads the
// renderer, so both are taken away for this file and put back after.
const STUBBED = ["document", "__BUILD_INFO__"] as const;
const stubs = new Map<string, PropertyDescriptor>();

beforeAll(async () => {
  for (const name of STUBBED) {
    const stub = Object.getOwnPropertyDescriptor(globalThis, name);
    if (stub === undefined) continue;
    stubs.set(name, stub);
    Reflect.deleteProperty(globalThis, name);
  }
  dir = mkdtempSync(join(tmpdir(), "collie-document-"));
  writeFileSync(join(dir, "index.html"), INDEX);
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../../web-remix/src/ssr/render.tsx")],
    outdir: join(dir, "renderer"),
    target: "bun",
  });
  if (!built.success) throw new AggregateError(built.logs, "renderer bundle failed");
  // SAFETY: the bundle of web-remix/src/ssr/render.tsx, whose exports are a ShellRenderer.
  renderer = (await import(built.outputs[0]!.path)) as ShellRenderer;
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [name, stub] of stubs) Object.defineProperty(globalThis, name, stub);
});

function config(over: Partial<Config> = {}): Config {
  // SAFETY: only what serveDocument and checkAccess read; the rest of Config is never touched here.
  return {
    allowAnyHost: false,
    publicHosts: [],
    tailscaleHosts: ["collie.example.ts.net"],
    allowedOrigins: [],
    trustedUser: "",
    trustedUserOptional: false,
    skipServe: false,
    basePath: "/",
    ...over,
  } as Config;
}

interface Seen {
  snapshotReads: number;
}

function deps(over: Partial<DocumentDeps> & { snap?: SnapshotResponse } = {}, seen: Seen = { snapshotReads: 0 }): DocumentDeps {
  const snap = over.snap ?? snapshotOf("alpha");
  return {
    cfg: config(),
    snapshot: () => {
      seen.snapshotReads++;
      return snap;
    },
    // SAFETY: the config fields the render reads; the rest are optional in the wire shape or unread.
    config: async () => ({ push: false, vapidPublicKey: "", build: "b1", mode: "solo" }) as DocumentInput["config"],
    renderer: async () => renderer,
    // No pane read unless a test gives one: the document is drawn as S1 drew it.
    paneRead: async () => new Response("herdr read failed", { status: 502 }),
    webDir: dir,
    buildId: async () => "build-1",
    now: () => TS,
    ...over,
  };
}

function get(path: string, init: RequestInit & { host?: string } = {}): [Request, URL] {
  const url = new URL(path, "http://collie.example.ts.net");
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? "collie.example.ts.net");
  return [new Request(url, { ...init, headers }), url];
}

/** The drawn markup, without `rmx-data` (which carries the snapshot as the island's props). */
function drawn(html: string): string {
  const at = html.indexOf('id="rmx-data"');
  return at === -1 ? html : html.slice(0, at);
}

describe("server document — gated", () => {
  test("GET / renders the snapshot's panes, no-store, under the strict CSP", async () => {
    const res = await serveDocument(deps(), ...get("/"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res!.headers.get("cache-control")).toBe("no-store");
    expect(res!.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res!.headers.get("x-collie-build")).toBe("build-1");
    const html = await res!.text();
    expect(drawn(html)).toContain("alpha-space");
    expect(html).not.toContain("boot-splash");
    expect(html).toContain('id="rmx-data"');
    // The head is the built file's, byte for byte.
    expect(html.startsWith(INDEX.slice(0, INDEX.indexOf("</head>")))).toBe(true);
  });

  test("GET /pane/:paneId renders that pane's view", async () => {
    const res = await serveDocument(deps(), ...get(`/pane/${encodeURIComponent("alpha-w1:p1")}`));
    expect(res?.status).toBe(200);
    expect(drawn(await res!.text())).toContain('data-testid="pane-view"');
  });

  test("HEAD answers the same headers and no body", async () => {
    const res = await serveDocument(deps(), ...get("/", { method: "HEAD" }));
    expect(res?.status).toBe(200);
    expect(res!.headers.get("cache-control")).toBe("no-store");
    expect(Number(res!.headers.get("content-length"))).toBeGreaterThan(1000);
    expect(await res!.text()).toBe("");
  });

  test("gzip when the browser accepts it", async () => {
    const res = await serveDocument(deps(), ...get("/", { headers: { "accept-encoding": "gzip, br" } }));
    expect(res!.headers.get("content-encoding")).toBe("gzip");
    const html = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res!.arrayBuffer())));
    expect(drawn(html)).toContain("alpha-space");
  });

  test("COLLIE_BASE_PATH: the head is mounted as the static shell's is, and drawn links carry the mount", async () => {
    const withLogo = async (): Promise<DocumentInput["config"]> =>
      // SAFETY: the header reads only `name` and `logoUrl` of the multiplexer block.
      ({ push: false, vapidPublicKey: "", mux: { name: "herdr", logoUrl: "/api/mux/logo.svg" } }) as DocumentInput["config"];
    const res = await serveDocument(deps({ cfg: config({ basePath: "/collie/" }), config: withLogo }), ...get("/"));
    const html = await res!.text();
    expect(html).toContain('<meta name="collie-base" content="/collie/" />');
    expect(html).toContain('src="/collie/assets/index-abc.js"');
    expect(html).toContain('href="/collie/assets/index-abc.css"');
    expect(drawn(html)).toContain('src="/collie/api/mux/logo.svg"');
  });
});

describe("server document — the static shell answers instead", () => {
  test("a request the access gate refuses never reads the snapshot", async () => {
    const seen = { snapshotReads: 0 };
    const gated = deps({ cfg: config({ trustedUser: "you@example.com" }) }, seen);
    expect(await serveDocument(gated, ...get("/"))).toBeNull();
    expect(await serveDocument(gated, ...get("/", { headers: { "tailscale-user-login": "someone@else.com" } }))).toBeNull();
    expect(await serveDocument(deps({}, seen), ...get("/", { host: "evil.example.com" }))).toBeNull();
    expect(await serveDocument(deps({}, seen), ...get("/", { headers: { origin: "https://evil.example.com" } }))).toBeNull();
    expect(seen.snapshotReads).toBe(0);
    // The same identity the gate trusts gets the document.
    const ok = await serveDocument(gated, ...get("/", { headers: { "tailscale-user-login": "you@example.com" } }));
    expect(ok?.status).toBe(200);
    expect(seen.snapshotReads).toBe(1);
  });

  test("every other path and method", async () => {
    for (const path of ["/settings", "/space/w1", "/pane/w1%3Ap1/history", "/machines", "/pane/", "/x/pane/w1"]) {
      expect(await serveDocument(deps(), ...get(path))).toBeNull();
    }
    expect(await serveDocument(deps(), ...get("/", { method: "POST" }))).toBeNull();
  });

  test("a build of web/'s React shell (no collie-shell marker) keeps its static file", async () => {
    const react = join(dir, "react");
    mkdirSync(react, { recursive: true });
    writeFileSync(join(react, "index.html"), INDEX.replace('    <meta name="collie-shell" content="remix" />\n', "").replace('<div id="boot-splash">splash</div>', '<div id="root"></div>'));
    const seen = { snapshotReads: 0 };
    expect(await serveDocument(deps({ webDir: react }, seen), ...get("/"))).toBeNull();
  });

  test("a snapshot refusal (unknown session), a missing build, a renderer that cannot load or throws", async () => {
    expect(await serveDocument(deps({ snapshot: () => new Response("no", { status: 404 }) }), ...get("/?s=nope"))).toBeNull();
    expect(await serveDocument(deps({ webDir: join(dir, "missing") }), ...get("/"))).toBeNull();
    expect(await serveDocument(deps({ renderer: async () => null }), ...get("/"))).toBeNull();
    const throwing: ShellRenderer = {
      ...renderer,
      renderAppDocument: () => Promise.reject(new Error("boom")),
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(await serveDocument(deps({ renderer: async () => throwing }), ...get("/"))).toBeNull();
    } finally {
      console.error = quiet;
    }
  });

  test("this test runtime loads the renderer source with the root tsconfig, and the loader refuses it", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(await loadShellRenderer(dir)).toBeNull();
    } finally {
      console.error = quiet;
    }
  });
});

describe("server document — no request sees another's panes", () => {
  test("back to back", async () => {
    const a = await (await serveDocument(deps({ snap: snapshotOf("alpha") }), ...get("/")))!.text();
    const b = await (await serveDocument(deps({ snap: snapshotOf("bravo") }), ...get("/")))!.text();
    expect(a).toContain("alpha-");
    expect(a).not.toContain("bravo-");
    expect(b).toContain("bravo-");
    expect(b).not.toContain("alpha-");
  });

  test("interleaved", async () => {
    const slow: DocumentDeps["config"] = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      // SAFETY: the config fields the render reads, as above.
      return { push: false, vapidPublicKey: "" } as DocumentInput["config"];
    };
    const [a, b, c] = await Promise.all([
      serveDocument(deps({ snap: snapshotOf("alpha"), config: slow }), ...get("/")),
      serveDocument(deps({ snap: snapshotOf("bravo") }), ...get(`/pane/${encodeURIComponent("bravo-w1:p1")}`)),
      serveDocument(deps({ snap: snapshotOf("alpha") }), ...get(`/pane/${encodeURIComponent("alpha-w1:p2")}`)),
    ]);
    const [ta, tb, tc] = await Promise.all([a!.text(), b!.text(), c!.text()]);
    for (const own of [ta, tc]) {
      expect(own).toContain("alpha-");
      expect(own).not.toContain("bravo-");
    }
    expect(tb).toContain("bravo-");
    expect(tb).not.toContain("alpha-");
  });
});

describe("prefsFromCookie", () => {
  test("reads the one cookie, URI-decoded, and nothing else", () => {
    expect(prefsFromCookie(null)).toBeNull();
    expect(prefsFromCookie("a=1; b=2")).toBeNull();
    expect(prefsFromCookie(`x=1; collie-prefs=${encodeURIComponent('{"k":"v"}')}; y=2`)).toBe('{"k":"v"}');
    expect(prefsFromCookie("collie-prefs=%E0%A4%A")).toBeNull();
  });
});
