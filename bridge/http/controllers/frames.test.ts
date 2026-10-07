// The pane's server frames (S2): a named-frame GET on `/pane/:paneId` answers that frame's rows as an
// HTML fragment, read through the pane route's own body; a matching ETag is a 304; every answer on the
// URL varies on the frame headers and is never stored; a top-frame GET of the same URL still gets the
// document; an ungated request gets the gate's refusal and no rows; two fragments never leak.
//
// The renderer is the shell's real one, bundled with `Bun.build` as document.test.ts bundles it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import type { BridgeHttp } from "../deps.ts";
import type { PaneWire, SnapshotResponse } from "../../types.ts";
import { serveDocument, type DocumentDeps, type DocumentInput, type ShellRenderer } from "./document.ts";
import { FRAME_ANSWER_HEADER, FRAME_VARY, serveFrame, type FrameDeps } from "./frames.ts";
import { browserPaneRead } from "./pane.ts";

const TS = 1_790_000_000_000;
const HOST = "collie.example.ts.net";
const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta name="collie-base" content="/" />
    <meta name="collie-shell" content="remix" />
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body>
    <div id="boot-splash">splash</div>
  </body>
</html>
`;

let dir = "";
let renderer: ShellRenderer;
const STUBBED = ["document", "__BUILD_INFO__"] as const;
const stubs = new Map<string, PropertyDescriptor>();

beforeAll(async () => {
  for (const name of STUBBED) {
    const stub = Object.getOwnPropertyDescriptor(globalThis, name);
    if (stub === undefined) continue;
    stubs.set(name, stub);
    Reflect.deleteProperty(globalThis, name);
  }
  dir = mkdtempSync(join(tmpdir(), "collie-frames-"));
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
  // SAFETY: only what the routes under test and checkAccess read.
  return {
    allowAnyHost: false,
    publicHosts: [],
    tailscaleHosts: [HOST],
    allowedOrigins: [],
    trustedUser: "",
    trustedUserOptional: false,
    skipServe: false,
    basePath: "/",
    ...over,
  } as Config;
}

function screenOf(tag: string): string {
  return Array.from({ length: 5 }, (_, i) => `${tag} line ${String(i)}`).join("\n");
}

/** A pane read as `readPane` answers it: ETag over the body, 304 on a match. Records each request. */
function paneReads(texts: Record<string, string>) {
  const seen: Request[] = [];
  const paneRead = async (req: Request, apiUrl: URL, rawPaneId: string): Promise<Response> => {
    seen.push(req);
    const paneId = decodeURIComponent(rawPaneId);
    const text = texts[paneId];
    if (text === undefined) return new Response("pane not found", { status: 404 });
    const body = JSON.stringify({ paneId, text, truncated: false, revision: 1 });
    const etag = `"${Bun.hash(body).toString(16)}"`;
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    expect(apiUrl.pathname).toBe(`/api/pane/${encodeURIComponent(paneId)}`);
    return new Response(body, { headers: { etag, "content-type": "application/json" } });
  };
  return { seen, paneRead };
}

function frameDepsOf(paneRead: FrameDeps["paneRead"]): FrameDeps {
  return { renderer: async () => renderer, paneRead, buildId: async () => "build-1" };
}

function get(path: string, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(path, `http://${HOST}`);
  return [new Request(url, { headers: { host: HOST, ...headers } }), url];
}

const frameHeaders = (target: string, extra: Record<string, string> = {}) => ({
  "x-remix-frame": "true",
  "x-remix-target": target,
  ...extra,
});

const PANE = `/pane/${encodeURIComponent("w1:p1")}?lines=600`;

describe("pane frames: answers", () => {
  test("each target answers its own fragment, with the read's ETag", async () => {
    const { paneRead } = paneReads({ "w1:p1": screenOf("alpha") });
    const screen = await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("pane-screen")));
    expect(screen?.status).toBe(200);
    expect(screen!.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(screen!.headers.get(FRAME_ANSWER_HEADER)).toBe("pane-screen");
    expect(screen!.headers.get("etag")).toMatch(/^"/);
    const html = await screen!.text();
    expect(html.match(/data-rmx-key="/g)?.length).toBe(5);
    expect(html).toContain("alpha line 4");
    expect(html).not.toContain("<html");

    const status = await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("pane-status")));
    expect(status?.status).toBe(200);
    expect(status!.headers.get(FRAME_ANSWER_HEADER)).toBe("pane-status");
    expect(await status!.text()).not.toContain("alpha line");
  });

  test("a poll answer carries the read and both frames in one body", async () => {
    const { paneRead, seen } = paneReads({ "w1:p1": screenOf("alpha") });
    const res = await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("pane-screen", { "x-collie-poll": "pane-screen,pane-status" })));
    const body = await res!.text();
    expect(body.startsWith('<script type="application/json" data-collie-pane-read>')).toBe(true);
    expect(body).toContain('<template data-collie-frame="pane-status">');
    expect(body).toContain('<template data-collie-frame="pane-screen">');
    // One pane read for the whole beat.
    expect(seen.length).toBe(1);
  });

  test("the pane is read as the JSON poll reads it: no frame headers, uncompressed, seen mark passed on", async () => {
    const { paneRead, seen } = paneReads({ "w1:p1": screenOf("alpha") });
    await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("pane-screen", { "accept-encoding": "gzip", "x-collie-seen": "1", "x-collie-poll": "pane-screen" })));
    const req = seen[0]!;
    expect(req.method).toBe("GET");
    expect(req.headers.get("x-remix-frame")).toBeNull();
    expect(req.headers.get("x-remix-target")).toBeNull();
    expect(req.headers.get("x-collie-poll")).toBeNull();
    expect(req.headers.get("accept-encoding")).toBeNull();
    expect(req.headers.get("x-collie-seen")).toBe("1");
    expect(req.headers.get("host")).toBe(HOST);
    expect(new URL(req.url).searchParams.get("lines")).toBe("600");
  });

  test("a matching If-None-Match is a 304 with no body and no render", async () => {
    const { paneRead } = paneReads({ "w1:p1": screenOf("alpha") });
    const first = await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("pane-screen")));
    const etag = first!.headers.get("etag")!;
    const again = await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("pane-screen", { "if-none-match": etag })));
    expect(again?.status).toBe(304);
    expect(again!.headers.get("etag")).toBe(etag);
    expect(again!.headers.get(FRAME_ANSWER_HEADER)).toBe("pane-screen");
    expect(await again!.text()).toBe("");
    const stale = await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("pane-screen", { "if-none-match": '"old"' })));
    expect(stale?.status).toBe(200);
  });

  test("Vary names the frame headers and nothing is stored, on 200, 304 and refusals alike", async () => {
    const { paneRead } = paneReads({ "w1:p1": screenOf("alpha") });
    const ok = await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("pane-screen")));
    const notModified = await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("pane-screen", { "if-none-match": ok!.headers.get("etag")! })));
    const missing = await serveFrame(frameDepsOf(paneRead), ...get(`/pane/${encodeURIComponent("w9:p9")}`, frameHeaders("pane-screen")));
    expect(missing?.status).toBe(404);
    for (const res of [ok!, notModified!, missing!]) {
      expect(res.headers.get("vary")).toContain(FRAME_VARY);
      expect(res.headers.get("vary")).toContain("X-Remix-Frame");
      expect(res.headers.get("vary")).toContain("X-Remix-Target");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-collie-build")).toBe("build-1");
    }
  });

  test("gzip when the browser accepts it, and Accept-Encoding joins Vary", async () => {
    const { paneRead } = paneReads({ "w1:p1": Array.from({ length: 200 }, (_, i) => `row ${String(i)} ${"x".repeat(20)}`).join("\n") });
    const res = await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("pane-screen", { "accept-encoding": "gzip" })));
    expect(res!.headers.get("content-encoding")).toBe("gzip");
    expect(res!.headers.get("vary")).toContain("Accept-Encoding");
    const html = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res!.arrayBuffer())));
    expect(html).toContain("row 199");
  });

  test("two panes, one after the other and at once: no fragment names the other's text", async () => {
    const { paneRead } = paneReads({ "a:1": screenOf("alpha"), "b:1": screenOf("bravo") });
    const deps = frameDepsOf(paneRead);
    const a = await (await serveFrame(deps, ...get(`/pane/a%3A1`, frameHeaders("pane-screen"))))!.text();
    const b = await (await serveFrame(deps, ...get(`/pane/b%3A1`, frameHeaders("pane-screen"))))!.text();
    const [c, d] = await Promise.all([
      serveFrame(deps, ...get(`/pane/a%3A1?agent=claude`, frameHeaders("pane-screen", { "x-collie-poll": "pane-screen,pane-status" }))).then((r) => r!.text()),
      serveFrame(deps, ...get(`/pane/b%3A1?agent=claude`, frameHeaders("pane-screen", { "x-collie-poll": "pane-screen,pane-status" }))).then((r) => r!.text()),
    ]);
    for (const out of [a, c]) {
      expect(out).toContain("alpha line");
      expect(out).not.toContain("bravo");
    }
    for (const out of [b, d]) {
      expect(out).toContain("bravo line");
      expect(out).not.toContain("alpha");
    }
  });

  test("not a frame request: null, so the document or the static shell answers", async () => {
    const { paneRead, seen } = paneReads({ "w1:p1": screenOf("alpha") });
    expect(await serveFrame(frameDepsOf(paneRead), ...get(PANE))).toBeNull();
    // Remix's own top-frame navigation carries the frame header but no target.
    expect(await serveFrame(frameDepsOf(paneRead), ...get(PANE, { "x-remix-frame": "true" }))).toBeNull();
    expect(seen.length).toBe(0);
  });

  test("an unknown frame or a non-pane path: 404 without the frame header, never a page", async () => {
    const { paneRead, seen } = paneReads({ "w1:p1": screenOf("alpha") });
    const odd = await serveFrame(frameDepsOf(paneRead), ...get(PANE, frameHeaders("sidebar")));
    expect(odd?.status).toBe(404);
    expect(odd!.headers.get(FRAME_ANSWER_HEADER)).toBeNull();
    const home = await serveFrame(frameDepsOf(paneRead), ...get("/", frameHeaders("pane-screen")));
    expect(home?.status).toBe(404);
    expect(await home!.text()).not.toContain("<html");
    expect(seen.length).toBe(0);
  });

  test("no renderer compiled in: 404 without the frame header, so the browser reads JSON", async () => {
    const { paneRead } = paneReads({ "w1:p1": screenOf("alpha") });
    const res = await serveFrame({ ...frameDepsOf(paneRead), renderer: async () => null }, ...get(PANE, frameHeaders("pane-screen")));
    expect(res?.status).toBe(404);
    expect(res!.headers.get(FRAME_ANSWER_HEADER)).toBeNull();
  });
});

describe("pane frames: the gate", () => {
  test("an ungated request gets the pane route's own refusal, and no rows", async () => {
    // The real pane route body with a host outside the allowlist: the gate answers before any read.
    const gateOnly: Partial<BridgeHttp> = { cfg: config(), pairing: undefined };
    // SAFETY: the gate reads cfg and pairing; nothing past the gate runs on a refusal, so the rest of
    // the bridge's deps are never touched.
    const deps = gateOnly as BridgeHttp;
    const frameDeps: FrameDeps = {
      renderer: async () => renderer,
      paneRead: (req, apiUrl, raw) => browserPaneRead(deps, req, apiUrl, raw),
      buildId: async () => "build-1",
    };
    const url = new URL(PANE, "http://evil.example");
    const req = new Request(url, { headers: { host: "evil.example", ...frameHeaders("pane-screen") } });
    const res = await serveFrame(frameDeps, req, url);
    expect(res?.status).toBe(403);
    expect(res!.headers.get(FRAME_ANSWER_HEADER)).toBe("pane-screen");
    expect(res!.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res!.text()).not.toContain("data-rmx-key");
  });
});

describe("pane frames: the document on the same URL", () => {
  function pane(n: number): PaneWire {
    return {
      paneId: `w1:p${String(n)}`,
      workspaceId: "w1",
      workspaceLabel: "space",
      workspaceNumber: 1,
      tabId: "w1:t1",
      tabLabel: "tab",
      agent: "claude",
      status: "working",
      cwd: "/home/you/project",
      focused: false,
      kind: "agent",
      hasSession: false,
    };
  }
  const snap: SnapshotResponse = {
    bridge: "connected",
    agents: [pane(1)],
    shellPanes: [],
    workspaces: [{ workspaceId: "w1", number: 1, label: "space", focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 1 }],
    tabs: [{ tabId: "w1:t1", workspaceId: "w1", number: 1, label: "tab", focused: true, paneCount: 1 }],
    sessions: [{ name: "main", isPrimary: true, reachable: true, agents: 1, working: 1, blocked: 0 }],
    ts: TS,
  };
  function docDeps(paneRead: DocumentDeps["paneRead"], over: Partial<DocumentDeps> = {}): DocumentDeps {
    return {
      cfg: config(),
      snapshot: () => snap,
      // SAFETY: the config fields the render reads.
      config: async () => ({ push: false, vapidPublicKey: "", build: "b1", mode: "solo" }) as DocumentInput["config"],
      renderer: async () => renderer,
      paneRead,
      webDir: dir,
      buildId: async () => "build-1",
      now: () => TS,
      ...over,
    };
  }

  test("a top-frame GET gets the document, its frames drawn inline from the read, and Vary", async () => {
    const { paneRead, seen } = paneReads({ "w1:p1": screenOf("alpha") });
    const [req, url] = get(`/pane/${encodeURIComponent("w1:p1")}`);
    expect(await serveFrame(frameDepsOf(paneRead), req, url)).toBeNull();
    const res = await serveDocument(docDeps(paneRead), req, url);
    expect(res?.status).toBe(200);
    expect(res!.headers.get("vary")).toContain("X-Remix-Frame");
    expect(res!.headers.get("vary")).toContain("X-Remix-Target");
    const html = await res!.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('data-frame="pane-screen"');
    expect(html).toContain("alpha line 4");
    // The document's read never marks the pane seen (a navigation can come from another site).
    expect(seen[0]!.headers.get("x-collie-seen")).toBeNull();
    expect(new URL(seen[0]!.url).searchParams.get("lines")).toBe("600");
  });

  test("a failed read leaves the document as S1 drew it", async () => {
    const res = await serveDocument(docDeps(async () => new Response("down", { status: 502 })), ...get(`/pane/${encodeURIComponent("w1:p1")}`));
    const html = await res!.text();
    expect(html).toContain('data-slot="screen-skeleton"');
  });

  test("COLLIE_BASE_PATH: the frames' src carries the mount, and the head stays mounted", async () => {
    const { paneRead } = paneReads({ "w1:p1": screenOf("alpha") });
    const res = await serveDocument(docDeps(paneRead, { cfg: config({ basePath: "/collie/" }) }), ...get(`/pane/${encodeURIComponent("w1:p1")}`));
    const html = await res!.text();
    expect(html).toContain('<meta name="collie-base" content="/collie/" />');
    expect(html).toContain('src="/collie/assets/index-abc.js"');
    expect(html).toContain("/collie/pane/w1%3Ap1?lines=600");
    expect(html).not.toMatch(/"\/pane\/w1%3Ap1\?lines=600/);
  });
});
