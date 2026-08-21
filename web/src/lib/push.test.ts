import { keysMatch, subscribeBody } from "./push";

// The VAPID-rotation guard in enablePush hinges on this byte compare: an existing PushManager
// subscription is bound to the applicationServerKey it was created with, so when the server rotates
// its VAPID keypair we must notice the mismatch and re-subscribe. (enablePush itself needs a real
// PushManager, which jsdom lacks, so we pin the pure compare here.)
const bufOf = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

describe("keysMatch", () => {
  it("is true when the existing key's bytes equal the server key", () => {
    expect(keysMatch(bufOf([1, 2, 3, 4]), new Uint8Array([1, 2, 3, 4]))).toBe(true);
  });

  it("is false when the bytes differ", () => {
    expect(keysMatch(bufOf([1, 2, 3, 4]), new Uint8Array([1, 2, 9, 4]))).toBe(false);
  });

  it("is false when the lengths differ", () => {
    expect(keysMatch(bufOf([1, 2, 3]), new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it("is false when there is no existing key (null / undefined)", () => {
    const server = new Uint8Array([1, 2, 3]);
    expect(keysMatch(null, server)).toBe(false);
    expect(keysMatch(undefined, server)).toBe(false);
  });
});

// The body `/api/subscribe` receives. A service worker re-registration mints a NEW endpoint and
// abandons the old one without unsubscribing it, so the push service keeps accepting sends to a row
// nobody reads (issue #104). Only this device knows the two endpoints are the same phone — `replaces`
// is how it says so, and the remembered endpoint is the whole of its memory.
describe("subscribeBody", () => {
  const json = { endpoint: "https://push/new", keys: { p256dh: "P", auth: "A" } };

  it("carries exactly endpoint + keys when this device has registered nothing before", () => {
    expect(subscribeBody(json, null)).toEqual({
      endpoint: "https://push/new",
      keys: { p256dh: "P", auth: "A" },
    });
  });

  it("supersedes the endpoint this device last registered", () => {
    expect(subscribeBody(json, "https://push/old")).toEqual({
      endpoint: "https://push/new",
      keys: { p256dh: "P", auth: "A" },
      replaces: "https://push/old",
    });
  });

  it("does not claim to supersede ITSELF — a re-register of the same endpoint replaces nothing", () => {
    expect(subscribeBody(json, "https://push/new").replaces).toBeUndefined();
  });

  it("ignores an empty remembered endpoint", () => {
    expect(subscribeBody(json, "").replaces).toBeUndefined();
  });

  it("never forwards a field the browser happened to put on the subscription", () => {
    const extra = { ...json, expirationTime: 123, junk: "x" } as PushSubscriptionJSON;
    expect(Object.keys(subscribeBody(extra, null)).sort()).toEqual(["endpoint", "keys"]);
  });
});
