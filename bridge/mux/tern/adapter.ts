// TERN, BEHIND THE CONTRACT — driving the Tern terminal multiplexer.

import { declareCapabilities } from "../capabilities.ts";
import { TERN_LOGO_SVG } from "./logo.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxAck,
  muxGone,
  muxOk,
  muxRefused,
  muxUnreachable,
  muxUnsupported,
  requestedCwd,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxGridRequest,
  type MuxOutcome,
  type MuxPane,
  type MuxRefusalOutcome,
  type MuxSession,
  type MuxSnapshot,
  type MuxSpace,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTab,
  type MuxTabRequest,
  type MuxWorktree,
  type MuxWorktreeCreateRequest,
  type MuxWorktreeOpenRequest,
  type MuxWorktreeOpened,
  type MuxWorktreeScope,
  type MuxWatchOptions,
} from "../types.ts";
import {
  resolveTernBinary,
  SpawnTernExec,
  type TernExec,
  type TernRunResult,
} from "./exec.ts";
import { toTernKey, TERN_UNSENDABLE_KEYS } from "./keys.ts";
import { ternBeaconMatcher } from "./markers.ts";
import {
  parseListing,
  saysNoBlock,
  saysNoDaemon,
  saysNoSession,
  type TernLsResult,
} from "./protocol.ts";
import { TernWatch } from "./watch.ts";

export const TERN_MUX = "tern";

interface RevisionEntry {
  revision: number;
  variants: Map<string, string>;
}

export class TernMux implements MuxAdapter {
  readonly mux = TERN_MUX;
  readonly logo = TERN_LOGO_SVG;

  readonly capabilities = declareCapabilities({
    supports: [
      "paneGrid",
      "gridScrollback",
      "typeText",
      "sendKeys",
      "closePane",
      "setFocus",
      "createTab",
      "renameTab",
      "closeTab",
      "createSpace",
      "pushTopologyEvents",
    ],
    spaces: "many",
    topologyLatency: { kind: "push" },
    unsupportedKeys: TERN_UNSENDABLE_KEYS,
  });

  private readonly revisions = new Map<string, RevisionEntry>();

  constructor(private readonly exec: TernExec) {}

  async reachable(): Promise<boolean> {
    try {
      const res = await this.exec.run(["ls", "--json"]);
      return res.code === 0;
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<MuxSnapshot> {
    const res = await this.attemptRun(["ls", "--json"]);
    if (!res.ok) {
      if (res.reason === "unreachable") throw new Error(res.detail);
      throw new Error(`failed to read tern snapshot: ${res.detail}`);
    }
    const ls = parseListing(res.value.stdout);
    return this.buildSnapshot(ls);
  }

  async refresh(): Promise<void> {
    // Round trips to tern CLI are always fresh.
    return Promise.resolve();
  }

  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    const args = ["capture", paneId];
    if (request.styling === "preserve") args.push("--ansi");
    if (request.scope === "recent") args.push("--scrollback");

    const result = await this.attemptRun(args);
    if (!result.ok) return result;

    const captured = result.value.stdout.replace(/\n$/u, "").split("\n");
    const kept = captured.slice(Math.max(0, captured.length - request.lines));
    const text = kept.join("\n");
    return muxOk({
      paneId,
      text,
      truncated: captured.length > kept.length,
      revision: this.advanceRevision(paneId, `${request.scope}|${request.styling}|${String(request.lines)}`, text),
    });
  }

  async readLogicalText(paneId: string, lines: number): Promise<MuxOutcome<string>> {
    const result = await this.attemptRun(["capture", paneId]);
    if (!result.ok) return result;
    const captured = result.value.stdout.replace(/\n$/u, "").split("\n");
    const kept = captured.slice(Math.max(0, captured.length - lines));
    return muxOk(kept.join("\n"));
  }

  async typeText(paneId: string, text: string): Promise<MuxAck> {
    if (text.length === 0) return muxAck();
    const args = ["send", paneId, text.includes("\n") ? "paste" : "text", text];
    const res = await this.attemptRun(args);
    if (!res.ok) return res;
    return muxAck();
  }

  async sendKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    const translated: string[] = [];
    for (const key of keys) {
      const res = toTernKey(key);
      if (!res.ok) {
        if (res.reason === "meta") {
          return muxRefused("Tern cannot send meta chords: terminal PTYs do not receive Super/Command");
        }
        return muxRefused(`Tern cannot send key: ${key}`);
      }
      translated.push(res.key);
    }
    const res = await this.attemptRun(["send", paneId, "keys", ...translated]);
    if (!res.ok) return res;
    return muxAck();
  }

  async renamePane(_paneId: string, _label: string | null): Promise<MuxAck> {
    return muxUnsupported("renamePane", "Tern does not support renaming individual panes");
  }

  async closePane(paneId: string): Promise<MuxAck> {
    const res = await this.attemptRun(["close", paneId]);
    if (!res.ok) return res;
    return muxAck();
  }

  async setFocus(paneId: string): Promise<MuxAck> {
    const res = await this.attemptRun(["focus", paneId]);
    if (!res.ok) return res;
    return muxAck();
  }

  async createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    const before = await this.snapshot();
    const args = ["new", "tab"];
    if (request.spaceId) {
      const space = before.spaces.find((s) => s.spaceId === request.spaceId);
      if (space) args.push(space.label);
    }
    const cwd = requestedCwd(request.cwd);
    if (cwd) args.push("--cwd", cwd);

    const result = await this.attemptRun(args);
    if (!result.ok) return result;

    const after = await this.snapshot();
    const beforeIds = new Set(before.panes.map((p) => p.paneId));
    const created = after.panes.find((p) => !beforeIds.has(p.paneId));
    if (created) {
      if (request.label && request.label.trim()) {
        await this.attemptRun(["rename", created.paneId, request.label.trim()]);
      }
      return muxOk({
        paneId: created.paneId,
        spaceId: created.spaceId,
        spaceLabel: created.spaceLabel,
        tabId: created.tabId,
        cwd: created.cwd,
      });
    }
    return muxRefused("tab was created but fresh pane was not found");
  }

  async renameTab(tabId: string, label: string): Promise<MuxAck> {
    const snap = await this.snapshot();
    const tab = snap.tabs.find((t) => t.tabId === tabId);
    if (!tab) return muxGone(`tab ${tabId} is gone`);
    const pane = snap.panes.find((p) => p.tabId === tabId);
    if (!pane) return muxGone(`tab ${tabId} has no live panes`);
    const res = await this.attemptRun(["rename", pane.paneId, label]);
    if (!res.ok) return res;
    return muxAck();
  }

  async closeTab(tabId: string): Promise<MuxAck> {
    const snap = await this.snapshot();
    const tabPanes = snap.panes.filter((p) => p.tabId === tabId);
    if (tabPanes.length === 0) return muxGone(`tab ${tabId} is gone`);
    for (const pane of tabPanes) {
      const res = await this.attemptRun(["close", pane.paneId]);
      if (!res.ok && res.reason !== "gone") return res;
    }
    return muxAck();
  }

  async createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    const before = await this.snapshot();
    const label = request.label?.trim() || `session-${String(Date.now())}`;
    const args = ["new", "session", label];
    const cwd = requestedCwd(request.cwd);
    if (cwd) args.push("--cwd", cwd);

    const result = await this.attemptRun(args);
    if (!result.ok) return result;

    const after = await this.snapshot();
    const beforeIds = new Set(before.panes.map((p) => p.paneId));
    const created = after.panes.find((p) => !beforeIds.has(p.paneId));
    if (created) {
      return muxOk({
        paneId: created.paneId,
        spaceId: created.spaceId,
        spaceLabel: created.spaceLabel,
        tabId: created.tabId,
        cwd: created.cwd,
      });
    }
    return muxRefused("space was created but fresh pane was not found");
  }

  async listWorktrees(_scope: MuxWorktreeScope): Promise<MuxOutcome<readonly MuxWorktree[]>> {
    return muxUnsupported("listWorktrees", "Tern does not track git worktrees");
  }

  async createWorktree(_request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return muxUnsupported("createWorktree", "Tern does not manage git worktrees");
  }

  async openWorktree(_request: MuxWorktreeOpenRequest): Promise<MuxOutcome<MuxWorktreeOpened>> {
    return muxUnsupported("openWorktree", "Tern does not manage git worktrees");
  }

  async listSessions(): Promise<MuxOutcome<readonly MuxSession[]>> {
    return muxUnsupported("listSessions", "Tern spaces are its sessions; listing separate daemons is not supported");
  }

  watch(options: MuxWatchOptions): MuxSubscription {
    return new TernWatch(this.exec, options);
  }

  private async attemptRun(args: readonly string[], stdin?: string): Promise<MuxOutcome<TernRunResult>> {
    let result: TernRunResult;
    try {
      result = await this.exec.run(args, stdin);
    } catch (err) {
      return muxUnreachable(err instanceof Error ? err.message : String(err));
    }
    return result.code === 0 ? muxOk(result) : refusalFor(result);
  }

  private advanceRevision(paneId: string, variant: string, text: string): number {
    const tracked = this.revisions.get(paneId) ?? { revision: 1, variants: new Map<string, string>() };
    this.revisions.set(paneId, tracked);
    const digest = contentDigest(text);
    const previous = tracked.variants.get(variant);
    if (previous === undefined) {
      if (tracked.variants.size > 0) tracked.revision += 1;
    } else if (previous !== digest) {
      tracked.revision += 1;
    }
    tracked.variants.delete(variant);
    tracked.variants.set(variant, digest);
    return tracked.revision;
  }

  private buildSnapshot(ls: TernLsResult): MuxSnapshot {
    const spaces: MuxSpace[] = [];
    const tabs: MuxTab[] = [];
    const panes: MuxPane[] = [];

    for (let sIdx = 0; sIdx < ls.sessions.length; sIdx++) {
      const s = ls.sessions[sIdx];
      if (!s) continue;
      const spaceId = String(s.id);
      const spaceLabel = s.name;
      const spaceNumber = sIdx + 1;
      const liveBlocksInSession = s.tabs.flatMap((t) => t.blocks).filter((b) => b.live && b.exited == null);
      const activeTab = s.tabs.find((t) => t.shown) ?? s.tabs[0];
      const activeTabId = activeTab ? String(activeTab.id) : "";

      spaces.push({
        spaceId,
        number: spaceNumber,
        label: spaceLabel,
        focused: s.shown,
        activeTabId,
        tabCount: s.tabs.length,
        paneCount: liveBlocksInSession.length,
        folder: liveBlocksInSession[0]?.cwd,
      });

      for (const t of s.tabs) {
        const tabId = String(t.id);
        const liveBlocksInTab = t.blocks.filter((b) => b.live && b.exited == null);

        tabs.push({
          tabId,
          spaceId,
          number: t.number,
          label: t.name ?? `Tab ${String(t.number)}`,
          focused: t.shown,
          paneCount: liveBlocksInTab.length,
        });

        for (const b of t.blocks) {
          const paneId = String(b.id);
          const alive = Boolean(b.live && b.exited == null);

          const pane: MuxPane = {
            paneId,
            spaceId,
            spaceLabel,
            spaceNumber,
            tabId,
            tabLabel: t.name ?? undefined,
            tabNamed: t.name != null ? true : undefined,
            cwd: b.cwd ?? "",
            focused: Boolean(b.focused),
            alive,
            agent: "shell",
            status: "unknown",
            terminalTitle: b.title ?? undefined,
            readableLines: (b.rows ?? 24) + 10000,
          };
          panes.push(pane);
        }
      }
    }
    return { panes, spaces, tabs };
  }
}

function refusalFor(result: TernRunResult): MuxRefusalOutcome {
  if (saysNoBlock(result.stderr)) return muxGone(result.stderr.trim());
  if (saysNoSession(result.stderr)) return muxGone(result.stderr.trim());
  if (saysNoDaemon(result.stderr)) return muxUnreachable(result.stderr.trim());
  return muxRefused(result.stderr.trim() || `tern exited ${String(result.code)}`);
}

function contentDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export const ternMuxFactory: MuxAdapterFactory = {
  mux: TERN_MUX,
  create(target: MuxTarget) {
    const binary = resolveTernBinary(target.options.binary ?? "");
    const exec = new SpawnTernExec(binary, target.endpoint, target.timeoutMs || 5000);
    return new TernMux(exec);
  },
  beaconMatcher(target: MuxTarget) {
    const binary = resolveTernBinary(target.options.binary ?? "");
    const exec = new SpawnTernExec(binary, target.endpoint, target.timeoutMs || 5000);
    return ternBeaconMatcher(TERN_MUX, exec, target.endpoint);
  },
  describeTarget(endpoint: string) {
    return endpoint.trim() ? `socket ${endpoint.trim()}` : "its default socket";
  },
};
