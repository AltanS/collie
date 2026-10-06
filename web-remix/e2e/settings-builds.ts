// Where the two bundles of the settings e2e live, and which one is being served. Shared by the
// global setup (builds them), the server (reads the pointer per request) and the spec (moves it).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 5196 by default; `SETTINGS_PORT` moves it, so a run can keep to the ports it was given. */
export const SETTINGS_PORT = Number(process.env.SETTINGS_PORT ?? "5196");
export const BUILDS_DIR = "/tmp/collie-remix-settings-e2e";
export const POINTER = join(BUILDS_DIR, "current");

export type BuildName = "a" | "b";

export function buildDir(name: BuildName): string {
  return join(BUILDS_DIR, name);
}

/** Serve `name` from the next request on: the deploy, from the server's side. */
export function serveBuild(name: BuildName): void {
  writeFileSync(POINTER, name);
}

export function servedBuild(): BuildName {
  try {
    return readFileSync(POINTER, "utf8").trim() === "b" ? "b" : "a";
  } catch {
    return "a";
  }
}

/** The build id the bundle carries, as the bridge would stamp it on `X-Collie-Build`. */
export function buildId(name: BuildName): string {
  // SAFETY: build-info.json is written by vite.config.ts's buildInfoPlugin, which always emits `id`.
  return (JSON.parse(readFileSync(join(buildDir(name), "build-info.json"), "utf8")) as { id: string }).id;
}

/** The entry chunk index.html names: two bundles, two entry chunks. */
export function entryScript(name: BuildName): string {
  const html = readFileSync(join(buildDir(name), "index.html"), "utf8");
  const match = /<script type="module" crossorigin src="([^"]+)"/.exec(html) ?? /<script[^>]+src="(\/assets\/[^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error(`no entry script in build ${name}`);
  return match[1];
}
