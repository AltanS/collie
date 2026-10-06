// The Settings sections' half of the wave-4 stub bridge: a handler for `installRoutesApi`
// (routes-api.ts) answering what Alerts, System and Appearance read and write, with state that
// behaves as the bridge does (a prefs POST merges and answers the merged view, a snooze sets a
// deadline the snapshot then carries, a forget drops the entry). Payloads are shaped like
// web/src/lib/types. Harness and multiplexer names never appear.
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString } from "@web/lib/json";
import type { CacheWatchListEntry, NotifyPrefs, SnapshotResponse, UpdateCheckResponse } from "@web/lib/types";

import { CONFIG, SNAPSHOT, UPDATE_CHECK, type StubHandler } from "./routes-api";

export interface SettingsStubState {
  prefs: NotifyPrefs;
  snoozedUntil: number | null;
  watched: CacheWatchListEntry[];
}

export interface SettingsStub {
  handler: StubHandler;
  state: SettingsStubState;
}

const check = (): UpdateCheckResponse => ({
  ...UPDATE_CHECK,
  crew: [{ name: "peer", version: "1.16.0", verdict: "green", reasons: [], asOf: Date.now() }],
});

const PREF_KEYS = ["blocked", "done", "updates", "cache", "machines"] as const;

export function settingsStub(): SettingsStub {
  const state: SettingsStubState = {
    prefs: { blocked: true, done: false, updates: true, cache: false, machines: true },
    snoozedUntil: null,
    watched: [
      { id: "watch-1", label: "build", host: "lead" },
      { id: "watch-2", label: "docs" },
    ],
  };
  const snapshot = (): SnapshotResponse => ({
    ...SNAPSHOT,
    notifications: { snoozedUntil: state.snoozedUntil },
    servers: [
      { id: "lead", name: "lead", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 1_790_000_000_000 },
      { id: "peer", name: "peer", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 1_790_000_000_000 },
    ],
    device: { enforced: false, device: null, authorized: true },
  });
  const handler: StubHandler = async (ctx) => {
    const key = `${ctx.method} ${ctx.url.pathname}`;
    switch (key) {
      case "GET /api/snapshot":
        await ctx.json(200, snapshot());
        return true;
      case "GET /api/config":
        await ctx.json(200, {
          ...CONFIG,
          push: true,
          vapidPublicKey: "BNqS-stub-public-key",
          operatorFonts: [{ family: "Fira Sans", basename: "fira.woff2" }],
        });
        return true;
      case "GET /api/update/check":
        await ctx.json(200, check());
        return true;
      case "GET /api/notifications/prefs":
        await ctx.json(200, state.prefs);
        return true;
      case "POST /api/notifications/prefs":
        // The app sends one key as a boolean; the bridge merges and answers the whole view.
        for (const name of PREF_KEYS) state.prefs[name] = asJsonBoolean(asJsonObject(ctx.body)?.[name]) ?? state.prefs[name];
        await ctx.json(200, state.prefs);
        return true;
      case "POST /api/notifications/snooze":
        state.snoozedUntil = asJsonNumber(asJsonObject(ctx.body)?.snoozedUntil) ?? null;
        await ctx.json(200, { snoozedUntil: state.snoozedUntil });
        return true;
      case "GET /api/notifications/cache-watch/list":
        await ctx.json(200, { entries: state.watched });
        return true;
      case "POST /api/notifications/cache-watch/forget": {
        const id = asJsonString(asJsonObject(ctx.body)?.id);
        state.watched = state.watched.filter((entry) => entry.id !== id);
        await ctx.json(200, { entries: state.watched });
        return true;
      }
      default:
        return false;
    }
  };
  return { handler, state };
}
