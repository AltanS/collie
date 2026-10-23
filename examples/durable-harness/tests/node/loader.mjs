// Node resolves a bare import from the importing file's folder. The SDK source lives in packages/durable-sdk/src,
// which has no install of its own, so its imports of Pi, durable-harness and @workflow/* resolve from this example's
// install instead: the copies durable-harness itself loads. (Bun reads the SDK's tsconfig paths, which send Pi to
// examples/durable-member's 1.1.0; a test that opens a real Harness therefore runs on Node, here.)
const EXAMPLE = new URL("../../package.json", import.meta.url).href;
const MAPPED = /^(@earendil-works\/|durable-harness(\/|$)|@workflow\/)/;

export async function resolve(specifier, context, next) {
  if (MAPPED.test(specifier) && context.parentURL !== undefined && !context.parentURL.includes("/node_modules/")) return next(specifier, { ...context, parentURL: EXAMPLE });
  return next(specifier, context);
}
