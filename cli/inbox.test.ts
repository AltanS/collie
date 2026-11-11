import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { capture, context, fakeFiles, fakeLinkFs, HOME } from "./fakes.ts";
import type { Environment } from "./context.ts";
import {
  cmdInbox,
  cmdInboxInstall,
  cmdInboxStatus,
  cmdInboxUninstall,
  INBOX_MARKER_PREFIX,
  type InboxDeps,
  inboxMarkerVersion,
  PI_EXTENSION_TEXT,
} from "./inbox.ts";
import { EXIT } from "./io.ts";
import type { LinkProbe } from "./link.ts";

// `collie inbox install|uninstall|status pi`. The filesystem and the symlink probe are fakes, so no
// test reaches a real `~/.pi`.

const EXT_DIR = join(HOME, ".pi", "agent", "extensions");
const TARGET = join(EXT_DIR, "collie-inbox.ts");
/** Where a stow-style `extensions` link points. */
const DOTFILES = join("/dotfiles", "pi-extensions");

function deps(
  over: { env?: Environment; files?: Record<string, string>; probes?: Record<string, LinkProbe> } = {},
): InboxDeps & { io: ReturnType<typeof capture>; files: ReturnType<typeof fakeFiles> } {
  const io = capture();
  const files = fakeFiles(over.files ?? {});
  return { ctx: context(over.env ?? {}), io, files, fs: fakeLinkFs(over.probes ?? {}) };
}

const text = (d: ReturnType<typeof deps>, path = TARGET): string | undefined => d.files.entries.get(path)?.text;

describe("the embedded extension", () => {
  test("is exactly the file on disk, so the binary never ships a stale copy", () => {
    const onDisk = readFileSync(join(import.meta.dir, "..", "pi-extension", "collie-inbox.ts"), "utf8");
    expect(PI_EXTENSION_TEXT).toBe(onDisk.replaceAll("\r\n", "\n"));
  });

  test("starts with the ownership marker, and the marker's version reads back", () => {
    expect(PI_EXTENSION_TEXT.startsWith(INBOX_MARKER_PREFIX)).toBe(true);
    expect(inboxMarkerVersion(PI_EXTENSION_TEXT)).toBe(1);
    expect(inboxMarkerVersion("// collie-inbox v7\nrest")).toBe(7);
    expect(inboxMarkerVersion("// something else\n")).toBeNull();
    expect(inboxMarkerVersion("// collie-inbox v\n")).toBeNull();
    expect(inboxMarkerVersion("")).toBeNull();
  });
});

describe("install pi", () => {
  test("a fresh install writes the embedded bytes, creates the folder and says /reload", () => {
    const d = deps();
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d)).toBe(PI_EXTENSION_TEXT);
    expect(d.files.entryTypes.get(EXT_DIR)).toBe("directory");
    expect(d.io.stdout.join("\n")).toContain(`✓ ${TARGET}`);
    expect(d.io.stdout.join("\n")).toContain("/reload");
  });

  test("writes a temp file in the same folder and renames it into place", () => {
    const d = deps();
    cmdInboxInstall(d, ["pi"]);
    expect(d.files.ops.map((op) => op.replaceAll("\\", "/"))).toEqual([`mv ${TARGET}.collie-tmp ${TARGET}`.replaceAll("\\", "/")]);
    expect(d.files.entries.has(`${TARGET}.collie-tmp`)).toBe(false);
    expect(d.files.entries.get(TARGET)?.mode).toBe(0o644);
  });

  test("a second install writes nothing and says so", () => {
    const d = deps({ files: { [TARGET]: PI_EXTENSION_TEXT } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(d.files.ops).toEqual([]);
    expect(d.io.stdout.join("\n")).toContain("already installed");
    expect(d.io.stdout.join("\n")).not.toContain("/reload");
  });

  test("an older marker version is replaced in place", () => {
    const old = PI_EXTENSION_TEXT.replace(/^.*\n/u, "// collie-inbox v0\n");
    const d = deps({ files: { [TARGET]: old } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d)).toBe(PI_EXTENSION_TEXT);
    expect(d.io.stdout.join("\n")).toContain("replaced the older copy, v0");
    expect(d.io.stdout.join("\n")).toContain("/reload");
  });

  test("our marker with changed bytes is healed", () => {
    const d = deps({ files: { [TARGET]: `${PI_EXTENSION_TEXT}// hand edit\n` } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d)).toBe(PI_EXTENSION_TEXT);
  });

  test("a file without our marker is someone else's: refused, untouched", () => {
    const theirs = "export default function () {}\n";
    const d = deps({ files: { [TARGET]: theirs } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(text(d)).toBe(theirs);
    expect(d.files.ops).toEqual([]);
    expect(d.io.stderr.join("\n")).toContain("not Collie's");
  });

  test("a marker that is not on the first line does not make a file ours", () => {
    const theirs = `// mine\n${INBOX_MARKER_PREFIX}1\n`;
    const d = deps({ files: { [TARGET]: theirs } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(text(d)).toBe(theirs);
  });

  test("a symlinked target file is refused and nothing is written", () => {
    const d = deps({ probes: { [TARGET]: { kind: "symlink", target: "/nix/store/x-collie-inbox.ts" } } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(d.files.entries.size).toBe(0);
    expect(d.files.ops).toEqual([]);
    expect(d.io.stderr.join("\n")).toContain("is a symlink");
  });

  test("a symlinked extensions folder is resolved, and the file lands at the real path", () => {
    const d = deps({ probes: { [EXT_DIR]: { kind: "symlink", target: DOTFILES } } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d, join(DOTFILES, "collie-inbox.ts"))).toBe(PI_EXTENSION_TEXT);
    expect(d.files.entries.has(TARGET)).toBe(false);
  });

  test("PI_CODING_AGENT_DIR moves the target, as it moves pi's own agent folder", () => {
    const d = deps({ env: { PI_CODING_AGENT_DIR: "/srv/pi-agent" } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d, join("/srv/pi-agent", "extensions", "collie-inbox.ts"))).toBe(PI_EXTENSION_TEXT);
    expect(d.files.entries.has(TARGET)).toBe(false);
  });

  test("PI_CODING_AGENT_DIR expands a leading ~ the way pi does", () => {
    const d = deps({ env: { PI_CODING_AGENT_DIR: "~/work/pi" } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.OK);
    expect(text(d, join(HOME, "work", "pi", "extensions", "collie-inbox.ts"))).toBe(PI_EXTENSION_TEXT);
  });

  test("a relative PI_CODING_AGENT_DIR is refused: no folder can be named", () => {
    const d = deps({ env: { PI_CODING_AGENT_DIR: "agent" } });
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(d.files.entries.size).toBe(0);
    expect(d.io.stderr.join("\n")).toContain("relative path");
  });

  test("a failed write removes the temp file and reports one line", () => {
    const d = deps();
    d.files.unrenamable.add(`${TARGET}.collie-tmp`);
    expect(cmdInboxInstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(d.files.entries.size).toBe(0);
    expect(d.io.stderr.join("\n")).toContain("could not write");
  });

  test("a missing or unknown harness is a usage error", () => {
    for (const args of [[], ["claude"], [""]]) {
      const d = deps();
      expect(cmdInboxInstall(d, args)).toBe(EXIT.USAGE);
      expect(d.io.stderr[0]).toBe("usage: collie inbox install {pi}");
      expect(d.files.entries.size).toBe(0);
    }
  });
});

describe("uninstall pi", () => {
  test("removes our file and says /reload", () => {
    const d = deps({ files: { [TARGET]: PI_EXTENSION_TEXT } });
    expect(cmdInboxUninstall(d, ["pi"])).toBe(EXIT.OK);
    expect(d.files.entries.has(TARGET)).toBe(false);
    expect(d.io.stdout.join("\n")).toContain("/reload");
  });

  test("removes our file at an older version too", () => {
    const d = deps({ files: { [TARGET]: "// collie-inbox v0\nold\n" } });
    expect(cmdInboxUninstall(d, ["pi"])).toBe(EXIT.OK);
    expect(d.files.entries.has(TARGET)).toBe(false);
  });

  test("leaves a foreign file and names it", () => {
    const theirs = "// not ours\n";
    const d = deps({ files: { [TARGET]: theirs } });
    expect(cmdInboxUninstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(text(d)).toBe(theirs);
    expect(d.io.stderr.join("\n")).toContain(TARGET);
  });

  test("a symlinked file is left alone", () => {
    const d = deps({
      files: { [TARGET]: PI_EXTENSION_TEXT },
      probes: { [TARGET]: { kind: "symlink", target: "/nix/store/x" } },
    });
    expect(cmdInboxUninstall(d, ["pi"])).toBe(EXIT.FAIL);
    expect(text(d)).toBe(PI_EXTENSION_TEXT);
  });

  test("with nothing installed it says so and succeeds", () => {
    const d = deps();
    expect(cmdInboxUninstall(d, ["pi"])).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("nothing to remove");
  });

  test("a missing harness is a usage error", () => {
    expect(cmdInboxUninstall(deps(), [])).toBe(EXIT.USAGE);
  });
});

describe("status", () => {
  const stateOf = (d: ReturnType<typeof deps>, args: string[] = ["pi"]): string => {
    expect(cmdInboxStatus(d, args)).toBe(EXIT.OK);
    return d.io.stdout.join("\n");
  };

  test("not installed", () => {
    const d = deps();
    expect(stateOf(d)).toContain("not installed");
    expect(d.files.entries.size).toBe(0);
  });

  test("installed and current", () => {
    const d = deps({ files: { [TARGET]: PI_EXTENSION_TEXT } });
    expect(stateOf(d)).toContain("installed and current");
    expect(d.files.ops).toEqual([]);
  });

  test("stale: an older marker, and our marker with other bytes", () => {
    const older = deps({ files: { [TARGET]: "// collie-inbox v0\n" } });
    expect(stateOf(older)).toContain("installed but stale (v0");
    expect(stateOf(older)).toContain("collie inbox install pi");
    expect(text(older)).toBe("// collie-inbox v0\n");
    const edited = deps({ files: { [TARGET]: `${PI_EXTENSION_TEXT}x` } });
    expect(stateOf(edited)).toContain("installed but stale");
    expect(text(edited)).toBe(`${PI_EXTENSION_TEXT}x`);
  });

  test("a foreign file is in the way", () => {
    const d = deps({ files: { [TARGET]: "mine\n" } });
    expect(stateOf(d)).toContain("is not Collie's");
    expect(text(d)).toBe("mine\n");
  });

  test("a symlinked file is reported as refused", () => {
    const d = deps({ probes: { [TARGET]: { kind: "symlink", target: "/x" } } });
    expect(stateOf(d)).toContain("refused");
  });

  test("a bare `status` reports pi, and an unknown harness is a usage error", () => {
    expect(stateOf(deps(), [])).toContain("pi:");
    const d = deps();
    expect(cmdInboxStatus(d, ["claude"])).toBe(EXIT.USAGE);
  });
});

describe("the parent verb", () => {
  test("dispatches the three sub-verbs", () => {
    const d = deps();
    expect(cmdInbox(d, ["install", "pi"])).toBe(EXIT.OK);
    expect(cmdInbox(d, ["status", "pi"])).toBe(EXIT.OK);
    expect(cmdInbox(d, ["uninstall", "pi"])).toBe(EXIT.OK);
    expect(d.files.entries.has(TARGET)).toBe(false);
  });

  test("a bare or misspelt sub-verb prints the usage and exits with USAGE", () => {
    const bare = deps();
    expect(cmdInbox(bare, [])).toBe(EXIT.USAGE);
    expect(bare.io.stderr[0]).toBe("usage: collie inbox {install|uninstall|status} {pi}");
    const typo = deps();
    expect(cmdInbox(typo, ["instal"])).toBe(EXIT.USAGE);
    expect(typo.io.stderr[0]).toContain("unknown inbox subcommand `instal`");
  });
});
