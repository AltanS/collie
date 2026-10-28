// The package's own version (its semver, not Collie's). `bun run sdk:build` writes `dist/core/version.js` from
// package.json, so the published file always names the version it ships in. This copy is what a program that imports
// the source reads, and a test holds it equal to package.json.
export const SDK_VERSION: string = "0.2.0";
