// The stub bridge the pane spec reads. Every `/api/*` request is answered here through
// `page.route`, and every write is RECORDED, so a spec asserts on what the screen sent, not on what
// it drew. Screens are real captures from web/src/fixtures/panes, served as the pane's mirror text;
// a spec can swap a pane's screen (the way a terminal repaints after a key) and the revision moves.
//
// Harness names are plain data on the snapshot rows, never a list the app matches against.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page, Route } from "@playwright/test";

import type { AgentView, BridgeConfig, PaneChatResponse, PaneReadResponse, SnapshotResponse } from "@web/lib/types";

const FIXTURES = join(import.meta.dirname, "..", "..", "web", "src", "fixtures", "panes");

/** A real capture's text, by file name. */
export function capture(file: string): string {
  return readFileSync(join(FIXTURES, file), "utf8");
}

function row(over: Partial<AgentView> & Pick<AgentView, "paneId" | "agent">): AgentView {
  return {
    workspaceId: "w1",
    workspaceLabel: "collie",
    workspaceNumber: 1,
    tabId: "w1:t1",
    tabLabel: "build",
    status: "idle",
    cwd: "/home/dev/project",
    focused: false,
    kind: "agent",
    ...over,
  };
}

/** The panes the spec opens, each named for what it shows. */
export const PANES = {
  chat: "w1:p1",
  permission: "w1:p4",
  walk: "w1:p3",
  plain: "w2:p1",
  wizard: "w1:p5",
  multi: "w1:p6",
  /** A Claude pane that named a session whose log is not there: the gate draws the Terminal. */
  noLog: "w1:p7",
  /** Present on the first snapshot; `closePane` takes it away. */
  closing: "w3:p1",
} as const;

export const PANE_SNAPSHOT: SnapshotResponse = {
  bridge: "connected",
  ts: 1_790_000_000_000,
  agents: [
    row({ paneId: PANES.chat, agent: "claude", hasSession: true, status: "idle", paneLabel: "fix flaky test" }),
    row({ paneId: PANES.walk, agent: "opencode", status: "blocked" }),
    row({ paneId: PANES.permission, agent: "claude", status: "blocked" }),
    row({ paneId: PANES.plain, agent: "some-new-harness", workspaceId: "w2", workspaceLabel: "website", tabId: "w2:t1" }),
    row({ paneId: PANES.wizard, agent: "claude", status: "blocked" }),
    row({ paneId: PANES.multi, agent: "claude", status: "blocked" }),
    row({ paneId: PANES.noLog, agent: "claude", hasSession: true, status: "idle" }),
    row({ paneId: PANES.closing, agent: "some-new-harness", workspaceId: "w3", workspaceLabel: "scratch", tabId: "w3:t1" }),
  ],
  shellPanes: [],
  workspaces: [
    { workspaceId: "w1", number: 1, label: "collie", focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 3 },
    { workspaceId: "w2", number: 2, label: "website", focused: false, activeTabId: "w2:t1", tabCount: 1, paneCount: 1 },
    { workspaceId: "w3", number: 3, label: "scratch", focused: false, activeTabId: "w3:t1", tabCount: 1, paneCount: 1 },
  ],
  tabs: [
    { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "build", focused: true, paneCount: 3 },
    { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "docs", focused: true, paneCount: 1 },
    { tabId: "w3:t1", workspaceId: "w3", number: 1, label: "tmp", focused: true, paneCount: 1 },
  ],
};

const PANE_CONFIG: BridgeConfig = { push: false, vapidPublicKey: "" };

/** The same bridge with speech to text and uploads switched on (ADR 0029, ADR 0060). */
const PANE_CONFIG_STT: BridgeConfig = {
  ...PANE_CONFIG,
  stt: { provider: "stub", available: true },
  upload: { maxBytes: 10 * 1024 * 1024, imageTypes: ["image/png", "image/jpeg"], textTypes: [".md", ".txt"] },
};

/** Where the stub says an upload landed on the host. */
export const UPLOAD_PATH = "/tmp/collie-upload/shot.png";

/** Plain terminal output with colour, for the Terminal tab. */
export const TERMINAL_TEXT = "\u001b[32m✓ 12 tests passed\u001b[0m\n\u001b[1mDone in 3.1s\u001b[0m\n$ ";

const TS = "2026-10-06T10:00:00.000Z";

export const CHAT_BODY: PaneChatResponse = {
  paneId: PANES.chat,
  available: true,
  page: "live",
  gen: 1,
  rev: 3,
  head: 1_000_002,
  oldest: 1_000_000,
  hasOlder: false,
  queued: [],
  upserts: [
    { uuid: "u1", seq: 1_000_000, ts: TS, role: "user", parts: [{ kind: "text", text: "Fix the flaky poll test" }] },
    {
      uuid: "a1",
      seq: 1_000_001,
      ts: TS,
      role: "assistant",
      parts: [
        { kind: "text", text: "Looking at **the poll test** now." },
        {
          kind: "tool",
          name: "Bash",
          summary: "bun test web/poll.test.ts",
          call: { kind: "execute", command: "bun test web/poll.test.ts" },
          result: { text: "1 pass\n0 fail" },
        },
      ],
    },
    { uuid: "a2", seq: 1_000_002, ts: TS, role: "assistant", parts: [{ kind: "text", text: "Fixed: the test now waits for the poll." }] },
  ],
};

export interface Write {
  path: "keys" | "reply" | "upload";
  paneId: string;
  body: { keys?: string[]; text?: string; submit?: boolean; expected_prompt?: string };
}

export interface StubBridge {
  writes: Write[];
  /** Repaint a pane: the next read returns `text` under a new revision. */
  setScreen(paneId: string, text: string): void;
  /** Called on every write, after it is recorded: a spec repaints the screen here. */
  onWrite(fn: (write: Write) => void): void;
  /** Take a pane out of the snapshot, as closing it in the terminal would. */
  closePane(paneId: string): void;
  /** How many snapshot reads were answered. */
  snapshots(): number;
}

export interface StubOptions {
  /** Answer every read with this status (401: not authorised). */
  refuse?: number;
  /** Refuse every write with the bridge's 403 "device not paired". */
  unpaired?: boolean;
  /** Serve the config with STT and uploads on. */
  stt?: boolean;
}

export async function stubPaneBridge(page: Page, screens: Record<string, string>, opts: StubOptions = {}): Promise<StubBridge> {
  const texts = new Map(Object.entries(screens));
  const revisions = new Map<string, number>();
  const writes: Write[] = [];
  const closed = new Set<string>();
  let snapshotReads = 0;
  let hook: ((write: Write) => void) | undefined;
  const stub: StubBridge = {
    writes,
    setScreen(paneId, text) {
      texts.set(paneId, text);
      revisions.set(paneId, (revisions.get(paneId) ?? 1) + 1);
    },
    onWrite(fn) {
      hook = fn;
    },
    closePane(paneId) {
      closed.add(paneId);
      texts.delete(paneId);
    },
    snapshots: () => snapshotReads,
  };

  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (opts.refuse !== undefined) return route.fulfill({ status: opts.refuse, body: "access refused" });
    if (url.pathname === "/api/snapshot") {
      snapshotReads++;
      const agents = PANE_SNAPSHOT.agents.filter((a) => !closed.has(a.paneId));
      return route.fulfill({ json: { ...PANE_SNAPSHOT, ts: Date.now(), agents } });
    }
    if (url.pathname === "/api/config") return route.fulfill({ json: opts.stt ? PANE_CONFIG_STT : PANE_CONFIG });
    const m = /^\/api\/pane\/([^/]+)(?:\/(chat|keys|reply|upload))?$/u.exec(url.pathname);
    if (m?.[1] !== undefined) {
      const paneId = decodeURIComponent(m[1]);
      const sub = m[2];
      if (sub === "chat") {
        if (paneId === PANES.chat) return route.fulfill({ json: CHAT_BODY });
        if (paneId === PANES.noLog) return route.fulfill({ json: { paneId, available: false, reason: "no-log" } });
        return route.fulfill({ json: { paneId, available: false, reason: "no-session" } });
      }
      if (sub === "upload") {
        writes.push({ path: "upload", paneId, body: {} });
        return route.fulfill({ json: { ok: true, path: UPLOAD_PATH } });
      }
      if (sub === "keys" || sub === "reply") {
        // SAFETY: the stub only records what the app posted; the spec asserts on each field it reads.
        const write: Write = { path: sub, paneId, body: req.postDataJSON() as Write["body"] };
        writes.push(write);
        if (opts.unpaired) return route.fulfill({ status: 403, body: "device not paired" });
        hook?.(write);
        return route.fulfill({ json: { ok: true } });
      }
      const text = texts.get(paneId);
      if (text === undefined) return route.fulfill({ status: 404, json: { error: "pane not found" } });
      const body: PaneReadResponse = { paneId, text, truncated: false, revision: revisions.get(paneId) ?? 1 };
      return route.fulfill({ json: body });
    }
    return route.fulfill({ status: 404, json: { error: "not stubbed" } });
  });
  return stub;
}
