// ESLint flat config — currently a single, targeted rule: the harness network-API fence.
//
// STATUS: this repo does not yet wire an ESLint runner. `eslint` (and a TypeScript parser such as
// `typescript-eslint`) are NOT in web/package.json devDependencies, and there is no `lint` script, so
// this config does not execute in CI today — it is ASPIRATIONAL. The REAL, live enforcement of this
// fence is `src/lib/harness/fence.test.ts`, which re-implements the same rule as a Vitest test and
// runs under `bun run test` (the pre-push hook). This config is declared here so the architectural
// fence lands WITH the harness refactor and takes over the moment a runner is added:
//   bun add -d eslint typescript-eslint
//   # web/package.json: "lint": "eslint src"
// To actually parse the .ts/.tsx files below, the runner must supply a TypeScript parser (e.g. wrap
// this export in typescript-eslint's `tseslint.config(...)`, or set `languageOptions.parser`). The
// fence rule itself is parser-agnostic — it only inspects `import ... from "…"` specifiers.
//
// THE FENCE: nothing under src/lib/harness/** may import the network API (@/lib/api, or a relative
// ../api / ../../api / ./api path). A socket call types into a REAL terminal; the harness layer is
// DETECTION only and must stay pure of I/O. The SOLE exception is src/lib/harness/guard.ts — the
// model-generic race-guard engine, which legitimately re-fetches the pane (fetchPane) before a
// guarded keystroke. The block below re-allows the network API for guard.ts and nothing else.

const NETWORK_API_FENCE_MESSAGE =
  "harness/ is detection-only — the network API (@/lib/api) is off-limits here. Only harness/guard.ts (the race-guard engine) may re-fetch the pane.";

const noNetworkApi = {
  paths: [{ name: "@/lib/api", message: NETWORK_API_FENCE_MESSAGE }],
  patterns: [
    {
      group: ["**/api", "**/lib/api", "./api", "../api", "../../api", "../../../api"],
      message: NETWORK_API_FENCE_MESSAGE,
    },
  ],
};

export default [
  {
    files: ["src/lib/harness/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", noNetworkApi] },
  },
  {
    // The race-guard engine is the ONE harness module allowed to touch the network (fetchPane). A
    // later, more specific config object wins under flat-config merge, so this turns the fence off
    // for guard.ts alone.
    files: ["src/lib/harness/guard.ts"],
    rules: { "no-restricted-imports": "off" },
  },
];
