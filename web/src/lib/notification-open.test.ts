import { describe, expect, test, vi } from "vitest";

import {
  openNotificationTarget,
  planNotificationOpen,
  type OpenTargetClient,
} from "@/lib/notification-open";

const URL_A = "https://collie.example/pane/p1";
const URL_B = "https://collie.example/settings";

/** A fake WindowClient that records the order its methods were called in, on a shared log. */
function fakeClient(
  log: string[],
  name: string,
  init: {
    url: string;
    visibilityState?: DocumentVisibilityState;
    focused?: boolean;
    /** What `navigate()` settles to: a truthy client, null (discarded tab), or a rejection. */
    navigate?: "ok" | "null" | "reject" | "never";
    focus?: "ok" | "reject";
  },
): OpenTargetClient {
  return {
    url: init.url,
    visibilityState: init.visibilityState,
    focused: init.focused,
    navigate: (url: string) => {
      log.push(`${name}.navigate(${url})`);
      if (init.navigate === "reject") return Promise.reject(new Error("gone"));
      if (init.navigate === "null") return Promise.resolve(null);
      if (init.navigate === "never") return new Promise(() => {});
      return Promise.resolve({ url });
    },
    focus: () => {
      log.push(`${name}.focus`);
      if (init.focus === "reject") return Promise.reject(new Error("not allowed"));
      return Promise.resolve({ url: init.url });
    },
  };
}

describe("planNotificationOpen", () => {
  test("no clients at all plans a window open with nothing to fall back to", () => {
    expect(planNotificationOpen([], URL_A)).toEqual({ kind: "open-window", fallbacks: [] });
  });

  test("a hidden client is never awaited first, it is only a fallback", () => {
    const hidden = fakeClient([], "hidden", { url: URL_B, visibilityState: "hidden" });
    expect(planNotificationOpen([hidden], URL_A)).toEqual({ kind: "open-window", fallbacks: [0] });
  });

  test("a visible client on the target URL is focused, not navigated", () => {
    const live = fakeClient([], "live", { url: URL_A, visibilityState: "visible" });
    expect(planNotificationOpen([live], URL_A)).toEqual({ kind: "focus", index: 0 });
  });

  test("a focused client counts as live even when visibilityState is missing", () => {
    const live = fakeClient([], "live", { url: URL_A, focused: true });
    expect(planNotificationOpen([live], URL_A)).toEqual({ kind: "focus", index: 0 });
  });

  test("a visible client on another URL is navigated then focused", () => {
    const live = fakeClient([], "live", { url: URL_B, visibilityState: "visible" });
    expect(planNotificationOpen([live], URL_A)).toEqual({ kind: "navigate-focus", index: 0 });
  });

  test("the live client on the target URL wins over an equally live one elsewhere", () => {
    const other = fakeClient([], "other", { url: URL_B, visibilityState: "visible" });
    const same = fakeClient([], "same", { url: URL_A, visibilityState: "visible" });
    expect(planNotificationOpen([other, same], URL_A)).toEqual({ kind: "focus", index: 1 });
  });
});

describe("openNotificationTarget", () => {
  test("with no clients it opens a window", async () => {
    const openWindow = vi.fn().mockResolvedValue({ url: URL_A });

    await expect(openNotificationTarget({ url: URL_A, clients: [], openWindow })).resolves.toBe(
      "opened",
    );
    expect(openWindow).toHaveBeenCalledExactlyOnceWith(URL_A);
  });

  test("a stale non-visible client is not awaited before openWindow", async () => {
    const log: string[] = [];
    // `navigate` here never settles — the Android case, where the WebAPK window is discarded and the
    // call hangs long enough to burn the tap's transient activation. If the implementation awaited
    // it, this test would time out instead of failing.
    const stale = fakeClient(log, "stale", { url: URL_B, navigate: "never" });
    const openWindow = vi.fn(async (url: string) => {
      log.push(`openWindow(${url})`);
      return { url };
    });

    await expect(
      openNotificationTarget({ url: URL_A, clients: [stale], openWindow }),
    ).resolves.toBe("opened");
    expect(log).toEqual([`openWindow(${URL_A})`]);
  });

  test("a visible client already on the target URL is only focused", async () => {
    const log: string[] = [];
    const live = fakeClient(log, "live", { url: URL_A, visibilityState: "visible" });
    const openWindow = vi.fn();

    await expect(openNotificationTarget({ url: URL_A, clients: [live], openWindow })).resolves.toBe(
      "focused",
    );
    expect(log).toEqual(["live.focus"]);
    expect(openWindow).not.toHaveBeenCalled();
  });

  test("a visible client on another URL is navigated, then focused", async () => {
    const log: string[] = [];
    const live = fakeClient(log, "live", { url: URL_B, visibilityState: "visible" });
    const openWindow = vi.fn();

    await expect(openNotificationTarget({ url: URL_A, clients: [live], openWindow })).resolves.toBe(
      "navigated",
    );
    expect(log).toEqual([`live.navigate(${URL_A})`, "live.focus"]);
    expect(openWindow).not.toHaveBeenCalled();
  });

  test("openWindow that throws once is retried immediately", async () => {
    const openWindow = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("not allowed", "NotAllowedError"))
      .mockResolvedValueOnce({ url: URL_A });

    await expect(openNotificationTarget({ url: URL_A, clients: [], openWindow })).resolves.toBe(
      "opened",
    );
    expect(openWindow).toHaveBeenCalledTimes(2);
  });

  test("a rejecting navigate on the visible client still ends with an open window", async () => {
    const log: string[] = [];
    const live = fakeClient(log, "live", {
      url: URL_B,
      visibilityState: "visible",
      navigate: "reject",
    });
    const openWindow = vi.fn(async (url: string) => {
      log.push(`openWindow(${url})`);
      return { url };
    });

    await expect(openNotificationTarget({ url: URL_A, clients: [live], openWindow })).resolves.toBe(
      "opened",
    );
    expect(log).toEqual([`live.navigate(${URL_A})`, `openWindow(${URL_A})`]);
  });

  test("#147: a discarded client whose navigate resolves null does not swallow the tap", async () => {
    const log: string[] = [];
    const discarded = fakeClient(log, "discarded", { url: URL_B, navigate: "null" });
    const openWindow = vi.fn(async (url: string) => {
      log.push(`openWindow(${url})`);
      return { url };
    });

    await expect(
      openNotificationTarget({ url: URL_A, clients: [discarded], openWindow }),
    ).resolves.toBe("opened");
    expect(log).toEqual([`openWindow(${URL_A})`]);
  });

  test("when openWindow is refused twice it falls back to navigating a hidden client", async () => {
    const log: string[] = [];
    const hidden = fakeClient(log, "hidden", { url: URL_B, visibilityState: "hidden" });
    const openWindow = vi.fn(async (url: string) => {
      log.push(`openWindow(${url})`);
      return null;
    });

    await expect(
      openNotificationTarget({ url: URL_A, clients: [hidden], openWindow }),
    ).resolves.toBe("navigated");
    expect(log).toEqual([
      `openWindow(${URL_A})`,
      `openWindow(${URL_A})`,
      `hidden.navigate(${URL_A})`,
      "hidden.focus",
    ]);
  });

  test("everything failing resolves to 'failed' rather than rejecting", async () => {
    const dead = fakeClient([], "dead", { url: URL_B, navigate: "null" });
    const openWindow = vi.fn().mockRejectedValue(new Error("nope"));

    await expect(openNotificationTarget({ url: URL_A, clients: [dead], openWindow })).resolves.toBe(
      "failed",
    );
  });
});
