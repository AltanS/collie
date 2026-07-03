import { keysMatch } from "./push";

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
