/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import type { UpdateInfo } from "@web/lib/types";
import { ribbonView } from "@web/lib/update-ribbon";

import { dismissedIn, stripOf } from "./update-ribbon";

const BASE: UpdateInfo = {
  current: "1.17.0",
  latest: null,
  latestUrl: null,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: 0,
};
const AVAILABLE: UpdateInfo = { ...BASE, latest: "1.18.0", releaseAvailable: true };

function view(update: UpdateInfo | undefined, extra: { bundleStale?: boolean; bundleInstalling?: boolean; dismissed?: string } = {}) {
  return ribbonView({
    update,
    bundleStale: extra.bundleStale ?? false,
    bundleInstalling: extra.bundleInstalling ?? false,
    dismissedVersion: extra.dismissed ?? null,
    dismissedCrewVersion: null,
    now: 1_000,
  });
}

describe("stripOf", () => {
  test("nothing to say draws no strip", () => {
    expect(stripOf(view(undefined), undefined)).toBeNull();
    expect(stripOf(view(BASE), BASE)).toBeNull();
  });

  test("an available release yields the available strip: caution, tap to Updates, offer close", () => {
    const strip = stripOf(view(AVAILABLE), AVAILABLE);
    expect(strip?.kind).toBe("available");
    expect(strip?.tone).toBe("caution");
    expect(strip?.spin).toBe(false);
    expect(strip?.tap).toBe("updates");
    expect(strip?.text).toContain("1.18.0");
    expect(strip?.dismiss).toMatchObject({ kind: "bridge", target: { scope: "offer", version: "1.18.0" } });
  });

  test("a packaged install yields available-packaged and still closes as an offer", () => {
    const update: UpdateInfo = { ...AVAILABLE, installKind: "packaged", packageCommand: "sudo pacman -Syu collie" };
    const strip = stripOf(view(update), update);
    expect(strip?.kind).toBe("available-packaged");
    expect(strip?.text).toContain("pacman");
    expect(strip?.dismiss?.kind).toBe("bridge");
  });

  test("a dismissed version is silent, a newer one is not", () => {
    expect(stripOf(view(AVAILABLE, { dismissed: "1.18.0" }), AVAILABLE)).toBeNull();
    expect(stripOf(view(AVAILABLE, { dismissed: "1.17.5" }), AVAILABLE)?.kind).toBe("available");
  });

  test("a stale bundle yields the reload strip: no close, tap reloads", () => {
    const strip = stripOf(view(BASE, { bundleStale: true }), BASE);
    expect(strip?.kind).toBe("bundle");
    expect(strip?.tap).toBe("reload");
    expect(strip?.dismiss).toBeNull();
  });

  test("a download yields the spinner row: no tap, a local close, hidden once closed", () => {
    const v = view(BASE, { bundleStale: true, bundleInstalling: true });
    const strip = stripOf(v, BASE);
    expect(strip?.kind).toBe("bundle-installing");
    expect(strip?.spin).toBe(true);
    expect(strip?.tap).toBeNull();
    expect(strip?.dismiss?.kind).toBe("local");
    expect(stripOf(v, BASE, true)).toBeNull();
  });

  test("a download without a stale bundle says nothing", () => {
    expect(stripOf(view(BASE, { bundleInstalling: true }), BASE)).toBeNull();
  });

  test("a failed peer is the one red strip, closable in the crew scope", () => {
    const update: UpdateInfo = {
      ...BASE,
      latest: "1.18.0",
      peers: [{ name: "minibuch", state: "rolled-back", reason: "health check failed" }],
    };
    const strip = stripOf(view(update), update);
    expect(strip?.kind).toBe("peer-failed");
    expect(strip?.tone).toBe("danger");
    expect(strip?.text).toContain("minibuch");
    expect(strip?.dismiss).toMatchObject({ kind: "bridge", target: { scope: "crew", version: "1.18.0" } });
  });
});

describe("dismissedIn", () => {
  test("this tab's own tap wins in its scope only", () => {
    const local = { scope: "offer", version: "1.18.0" } as const;
    expect(dismissedIn("offer", local, "1.17.0")).toBe("1.18.0");
    expect(dismissedIn("crew", local, "1.17.0")).toBe("1.17.0");
    expect(dismissedIn("offer", null, undefined)).toBeNull();
  });
});
