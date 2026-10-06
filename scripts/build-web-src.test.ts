import { describe, expect, test } from "bun:test";

import { hostFor } from "../bridge/host.ts";
import { cmdBuild, DEFAULT_WEB_SRC, resolveWebSrc, WEB_SRC_ENV, WEB_SRC_FILE, webDist, webStaging } from "../cli/build.ts";
import { capture, context, fakeExec, fakeFiles, ROOT, type SeededFiles } from "../cli/fakes.ts";
import type { Environment } from "../cli/context.ts";
import { EXIT } from "../cli/io.ts";

// `COLLIE_WEB_SRC` and `.collie-web-src` choose which directory the web step builds. The fakes stand
// in for the filesystem and for Vite: no real build runs here, only the commands the build would run.

const REMIX = `${ROOT}/web-remix`;
const seed = (extra: SeededFiles = {}): SeededFiles => ({
  [`${ROOT}/web/package.json`]: "{}",
  [`${REMIX}/package.json`]: "{}",
  ...extra,
});

function pick(env: Environment, files: SeededFiles) {
  return resolveWebSrc(ROOT, env, fakeFiles(files));
}

describe("resolveWebSrc", () => {
  test("defaults to web", () => {
    const got = pick({}, seed());
    expect(got).toEqual({ ok: true, src: { name: DEFAULT_WEB_SRC, dir: `${ROOT}/web`, from: "default" } });
  });

  test("the env var overrides the default", () => {
    const got = pick({ [WEB_SRC_ENV]: "web-remix" }, seed());
    expect(got).toEqual({
      ok: true,
      src: { name: "web-remix", dir: `${ROOT}/web-remix`, from: "env COLLIE_WEB_SRC" },
    });
  });

  test("the file overrides the default, and only its first line counts", () => {
    const got = pick({}, seed({ [`${ROOT}/${WEB_SRC_FILE}`]: "web-remix\nignored\n" }));
    expect(got).toEqual({
      ok: true,
      src: { name: "web-remix", dir: `${ROOT}/web-remix`, from: "file .collie-web-src" },
    });
  });

  test("env beats file, and file beats web", () => {
    const files = seed({ [`${ROOT}/${WEB_SRC_FILE}`]: "web-remix\n", [`${ROOT}/other/package.json`]: "{}" });
    const both = pick({ [WEB_SRC_ENV]: "other" }, files);
    expect(both.ok && both.src.name).toBe("other");
    const fileOnly = pick({}, files);
    expect(fileOnly.ok && fileOnly.src.name).toBe("web-remix");
  });

  test("a blank env var or a blank file counts as unset", () => {
    const got = pick({ [WEB_SRC_ENV]: "  " }, seed({ [`${ROOT}/${WEB_SRC_FILE}`]: "\n" }));
    expect(got.ok && got.src.from).toBe("default");
  });

  test("a directory without package.json fails and names the env setting", () => {
    const got = pick({ [WEB_SRC_ENV]: "missing" }, seed());
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("COLLIE_WEB_SRC");
    expect(got.error).toContain("missing");
  });

  test("a bad value in the file names the file", () => {
    const got = pick({}, seed({ [`${ROOT}/${WEB_SRC_FILE}`]: "nowhere\n" }));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain(".collie-web-src");
    expect(got.error).toContain("nowhere");
  });

  test.each(["../web", "web/src", "/etc", "..", ".", "a b", "web;ls"])("%p is not a plain directory name", (value) => {
    const got = pick({ [WEB_SRC_ENV]: value }, seed());
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("COLLIE_WEB_SRC");
    expect(got.error).toContain("plain directory name");
  });
});

describe("cmdBuild with a chosen web source", () => {
  function run(env: Environment, files: SeededFiles) {
    const io = capture();
    const exec = fakeExec({});
    const fs = fakeFiles({ [`${ROOT}/web/dist/index.html`]: "OLD", ...files });
    const code = cmdBuild({ ctx: context(env), io, exec, files: fs, host: hostFor("linux") });
    return { code, io, exec, fs };
  }
  const calls = (exec: { calls: string[] }): string[] => exec.calls.filter((c) => !c.includes(" build --compile "));

  test("the default builds in web, stages in dist-staging and says so", () => {
    const h = run({}, seed());
    expect(h.code).toBe(EXIT.OK);
    expect(h.io.stdout).toContain("web source: web/ (default)");
    expect(calls(h.exec)).toContain(`${ROOT}/web$ bun run build -- --outDir dist-staging --emptyOutDir`);
  });

  test("a sibling directory installs, typechecks and builds there, but stages at web/dist-staging", () => {
    const h = run({ [WEB_SRC_ENV]: "web-remix" }, seed());
    expect(h.code).toBe(EXIT.OK);
    expect(h.io.stdout).toContain("web source: web-remix/ (env COLLIE_WEB_SRC)");
    const got = calls(h.exec);
    expect(got).toContain(`${REMIX}$ bun install`);
    expect(got).toContain(`${REMIX}$ bun run typecheck`);
    expect(got).toContain(`${REMIX}$ bun run build -- --outDir ../web/dist-staging --emptyOutDir`);
    expect(got.some((c) => c.startsWith(`${ROOT}/web$`))).toBe(false);
    // The swap is unchanged: the staged bundle becomes web/dist.
    expect(h.fs.ops.slice(-2)).toEqual([`rm -rf ${webDist(ROOT)}`, `mv ${webStaging(ROOT)} ${webDist(ROOT)}`]);
  });

  test("an invalid value fails right after the version gate, before any install, naming the setting", () => {
    const h = run({ [WEB_SRC_ENV]: "../escape" }, seed());
    expect(h.code).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("COLLIE_WEB_SRC");
    expect(h.exec.calls).toEqual([`${ROOT}$ bash ${ROOT}/scripts/check-version.sh`]);
    expect(h.fs.entries.get(`${webDist(ROOT)}/index.html`)?.text).toBe("OLD");
  });
});
