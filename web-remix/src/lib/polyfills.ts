// Three runtime needs that some browsers lack, filled before `run()` (main.tsx), each only when
// missing (research note 08, 4.6 and 4.7; kody's `ensureCryptoRandomUUID`).
//
// - `crypto.randomUUID` is secure-context only, so a plain-HTTP tailnet origin such as
//   `http://bluefin:8792` has none. remix/component calls it for every `<Frame>` the browser renders
//   itself (`randomFrameId`). Built from `crypto.getRandomValues`, which every context has.
// - `Promise.withResolvers` and `Object.hasOwn`: the runtime's hydration uses both, and older
//   in-app browsers lack them.

function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: PromiseWithResolvers<T>["resolve"];
  let reject!: PromiseWithResolvers<T>["reject"];
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const hasOwn: ObjectConstructor["hasOwn"] = (target, key) => Object.prototype.hasOwnProperty.call(target, key);

/** Fill whichever of the three is missing. Idempotent. */
export function installPolyfills(): void {
  if (!("randomUUID" in crypto)) Object.defineProperty(crypto, "randomUUID", { value: randomUUID, configurable: true });
  if (!("withResolvers" in Promise)) Object.defineProperty(Promise, "withResolvers", { value: withResolvers, configurable: true });
  // Asked through the prototype: an `in` test would narrow `Object` itself to never.
  if (!Object.prototype.hasOwnProperty.call(Object, "hasOwn")) {
    Object.defineProperty(Object, "hasOwn", { value: hasOwn, configurable: true });
  }
}
