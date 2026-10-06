// The stub bridge for the settings e2e, after web/e2e/fixtures/api.ts: every `/api/*` the settings
// screens call, answered in the browser context (`context.route`, which in Chromium also covers a
// request a service worker forwards), with a device registry that behaves as bridge/pairing.ts does.
//
//   POST /api/pair            no token needed; a known code mints a token once, a wrong one is a
//                             named 400 (`bad-code`), a taken name is `duplicate-label`
//   GET  /api/devices         enforced = anything paired; `current` = who the bearer token names
//   POST /api/devices/revoke  needs a paired bearer token (403 `device not paired` otherwise)
//   GET  /api/update/check    a fixed read-only answer
//   GET  /api/snapshot        an empty herd, with `X-Collie-Build` when `state.build` is set
//
// Harness and multiplexer names never appear: the screens under test name none.
import type { BrowserContext, Request, Route } from "@playwright/test";

import type { DevicesResponse, SnapshotResponse, UpdateCheckResponse } from "@web/lib/types";

export const PAIR_CODE = "ABCD2345";

export interface StubDevice {
  label: string;
  token: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface SettingsApi {
  /** The `X-Collie-Build` this "bridge" stamps on the snapshot, or undefined for none. */
  build: string | undefined;
  devices: StubDevice[];
  /** Every request the stub answered, for the assertions on headers. */
  log: { method: string; path: string; authorization: string | null }[];
}

const SNAPSHOT: SnapshotResponse = {
  bridge: "connected",
  ts: 1_790_000_000_000,
  agents: [],
  shellPanes: [],
  workspaces: [],
  tabs: [],
};

const UPDATE_CHECK: UpdateCheckResponse = {
  current: "1.17.0",
  latest: "1.17.0",
  latestUrl: null,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: Date.now() - 120_000,
  preflight: { schema: 1, verdict: "green", checks: [{ id: "disk", verdict: "green", reason: "ok" }] },
};

function bearer(request: Request): string | null {
  const auth = request.headers().authorization ?? null;
  return auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
}

function registry(api: SettingsApi, token: string | null): DevicesResponse {
  const me = api.devices.find((d) => d.token === token) ?? null;
  return {
    enforced: api.devices.length > 0,
    current: me?.label ?? null,
    devices: api.devices.map((d) => ({ label: d.label, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, current: d === me })),
  };
}

function json<T extends object>(route: Route, status: number, body: T, headers: Record<string, string> = {}): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
}

export async function installSettingsApi(context: BrowserContext): Promise<SettingsApi> {
  const api: SettingsApi = { build: undefined, devices: [], log: [] };
  let minted = 0;
  await context.route(/\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const token = bearer(request);
    api.log.push({ method, path: url.pathname, authorization: request.headers().authorization ?? null });
    switch (`${method} ${url.pathname}`) {
      case "GET /api/snapshot":
        return json(route, 200, SNAPSHOT, api.build ? { "x-collie-build": api.build } : {});
      case "GET /api/config":
        return json(route, 200, { push: false, vapidPublicKey: "" });
      case "GET /api/devices":
        return json(route, 200, registry(api, token));
      case "GET /api/update/check":
        return json(route, 200, UPDATE_CHECK);
      case "POST /api/pair": {
        // SAFETY: the app sends `{ code, label }` as JSON (lib/pairing-api.ts pairDevice).
        const body = request.postDataJSON() as { code?: string; label?: string };
        if (body.code !== PAIR_CODE) return json(route, 400, { error: "bad-code" });
        if (!body.label) return json(route, 400, { error: "bad-request" });
        if (api.devices.some((d) => d.label === body.label)) return json(route, 400, { error: "duplicate-label" });
        minted += 1;
        const device = { label: body.label, token: `tok-${String(minted)}`, createdAt: Date.now(), lastSeenAt: Date.now() };
        api.devices.push(device);
        return json(route, 200, { token: device.token, label: device.label });
      }
      case "POST /api/devices/revoke": {
        if (!api.devices.some((d) => d.token === token)) return route.fulfill({ status: 403, body: "device not paired" });
        // SAFETY: the app sends `{ label }` as JSON (lib/pairing-api.ts revokeDevice).
        const { label } = request.postDataJSON() as { label: string };
        api.devices = api.devices.filter((d) => d.label !== label);
        return json(route, 200, registry(api, token));
      }
      default:
        return route.fulfill({ status: 404, body: `no stub for ${method} ${url.pathname}` });
    }
  });
  return api;
}
