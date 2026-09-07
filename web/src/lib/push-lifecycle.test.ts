import { fetchConfig, registerPushSubscription } from "@/lib/api";
import { disablePush, enablePush, getPushState } from "./push";

vi.mock("@/lib/api", () => ({
  fetchConfig: vi.fn(),
  registerPushSubscription: vi.fn(),
}));

const key = Uint8Array.from({ length: 65 }, (_, i) => i === 0 ? 4 : 1);
const vapidPublicKey = btoa(String.fromCharCode(...key)).replace(/=/g, "");
const subscription = {
  endpoint: "https://push.example.test/device",
  options: { applicationServerKey: key.buffer },
  toJSON: () => ({
    endpoint: "https://push.example.test/device",
    keys: { p256dh: "test-key", auth: "test-auth" },
  }),
  unsubscribe: vi.fn(async () => {
    current = null;
    return true;
  }),
};
let current: typeof subscription | null = null;
const pushManager = {
  getSubscription: vi.fn(async () => current),
  subscribe: vi.fn(async () => {
    current = subscription;
    return subscription;
  }),
};
const registration = { pushManager };
let serviceWorkerDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  current = null;
  vi.mocked(fetchConfig).mockReset().mockResolvedValue({ push: true, vapidPublicKey });
  vi.mocked(registerPushSubscription).mockReset().mockResolvedValue(undefined);
  pushManager.getSubscription.mockReset().mockImplementation(async () => current);
  pushManager.subscribe.mockReset().mockImplementation(async () => {
    current = subscription;
    return subscription;
  });
  subscription.unsubscribe.mockReset().mockImplementation(async () => {
    current = null;
    return true;
  });
  serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn().mockResolvedValue(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    },
  });
  vi.stubGlobal("PushManager", vi.fn());
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("isSecureContext", true);
  localStorage.setItem("collie:push-disabled", "1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (serviceWorkerDescriptor) {
    Object.defineProperty(navigator, "serviceWorker", serviceWorkerDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

describe("push subscription lifecycle", () => {
  it("can enable, disable, and enable again after both registrations succeed", async () => {
    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect((await getPushState()).subscribed).toBe(true);
    await disablePush();
    expect(await getPushState()).toMatchObject({ subscribed: false, userDisabled: true });
    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(await getPushState()).toMatchObject({ subscribed: true, userDisabled: false });
    expect(pushManager.subscribe).toHaveBeenCalledTimes(2);
    expect(registerPushSubscription).toHaveBeenCalledTimes(2);
  });

  it("keeps push off when the bridge rejects registration, and can retry the same subscription", async () => {
    vi.mocked(registerPushSubscription).mockRejectedValueOnce(new Error("sign in required"));
    await expect(enablePush()).rejects.toThrow("sign in required");
    expect(await getPushState()).toMatchObject({ subscribed: false, userDisabled: true });
    expect(localStorage.getItem("collie:push-endpoint")).toBeNull();

    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(await getPushState()).toMatchObject({ subscribed: true, userDisabled: false });
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it("does not show an unacknowledged subscription as on for a first-time user", async () => {
    localStorage.removeItem("collie:push-disabled");
    vi.mocked(registerPushSubscription).mockRejectedValueOnce(new Error("registration refused"));
    await expect(enablePush()).rejects.toThrow("registration refused");
    expect((await getPushState()).subscribed).toBe(false);
  });

  it("surfaces a browser registration failure and allows a later attempt", async () => {
    pushManager.subscribe.mockRejectedValueOnce(
      new DOMException("Registration failed - push service error", "AbortError"),
    );
    await expect(enablePush()).rejects.toThrow("push service error");
    expect(registerPushSubscription).not.toHaveBeenCalled();
    expect((await getPushState()).userDisabled).toBe(true);
    await expect(enablePush()).resolves.toEqual({ ok: true });
  });

  it("reports an unavailable config as retryable rather than claiming VAPID is disabled", async () => {
    vi.mocked(fetchConfig).mockRejectedValueOnce(new Error("offline"));
    expect(await getPushState()).toMatchObject({ availability: "unavailable", userDisabled: true });
    await expect(enablePush()).resolves.toEqual({ ok: true });
  });

  it("still distinguishes a bridge that actually has no push configuration", async () => {
    vi.mocked(fetchConfig).mockResolvedValue({ push: false, vapidPublicKey: "" });
    expect((await getPushState()).availability).toBe("server-off");
  });

  it("times out a stalled subscription without registering it after the timeout", async () => {
    vi.useFakeTimers();
    let finish: ((value: typeof subscription) => void) | undefined;
    pushManager.subscribe.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const rejected = expect(enablePush()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(registerPushSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem("collie:push-disabled")).toBe("1");

    current = subscription;
    finish?.(subscription);
    await vi.advanceTimersByTimeAsync(0);
    expect(registerPushSubscription).not.toHaveBeenCalled();
    await expect(enablePush()).resolves.toEqual({ ok: true });
    expect(registerPushSubscription).toHaveBeenCalledTimes(1);
  });

  it("waits for an active service worker before subscribing", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator.serviceWorker, "ready", { value: new Promise(() => {}) });
    const rejected = expect(enablePush()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("remembers a successful registration for this page when storage writes are blocked", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    });
    try {
      await expect(enablePush()).resolves.toEqual({ ok: true });
      expect((await getPushState()).subscribed).toBe(true);
    } finally {
      setItem.mockRestore();
      await disablePush();
    }
  });
});
