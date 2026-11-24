import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { fullReminder } from "./beacon-asks.ts";
import { context, fakeLinkFs, HOME, ROOT } from "./fakes.ts";
import { resolveHookCommand } from "./hooks.ts";
import { renderWalkySkill } from "./skill-install.ts";
import { collieBinary } from "./unit.ts";

// The name the WalkyTalky skill gives an agent for `collie` ({{COLLIE_BIN}}, `renderWalkySkill`) and the name the
// full reminder of open asks prints (`fullReminder`, whose binary `beacon asks` takes from
// `resolveHookCommand(ctx, realLinkFs).binary` in cli/program.ts) are one string by construction: both are
// `resolveHookCommand(...).binary` over the same context and link probe. A person who allowed the skill's
// `<binary> walky` gets no permission card for the reminder's command. Pinned for each install kind.

/** The `walky cancel` command a text names: everything before ` walky cancel <id>`. */
function cancelBinary(text: string): string | null {
  const line = text.split("\n").find((l) => l.includes(" walky cancel <id>"));
  return line === undefined ? null : line.slice(0, line.indexOf(" walky cancel <id>")).trim();
}

describe("the skill's command and the reminder's command", () => {
  const PUBLISHED = join(HOME, ".local", "bin", "collie");
  const INSTALL_ROOT = resolve(HOME, ".local", "share", "collie");
  const VERSION_ROOT = join(INSTALL_ROOT, "versions", "1.31.0");
  const kinds = [
    { kind: "a checkout", ctx: context(), fs: fakeLinkFs(), binary: collieBinary(ROOT) },
    { kind: "a checkout with the PATH name", ctx: context(), fs: fakeLinkFs({ [PUBLISHED]: { kind: "symlink", target: collieBinary(ROOT) } }), binary: PUBLISHED },
    { kind: "a binary install", ctx: context({}, { root: VERSION_ROOT }), fs: fakeLinkFs({ [`${INSTALL_ROOT}/current`]: { kind: "symlink", target: VERSION_ROOT } }), binary: collieBinary(join(INSTALL_ROOT, "current")) },
    {
      kind: "a binary install with the PATH name",
      ctx: context({}, { root: VERSION_ROOT }),
      fs: fakeLinkFs({ [`${INSTALL_ROOT}/current`]: { kind: "symlink", target: VERSION_ROOT }, [PUBLISHED]: { kind: "symlink", target: collieBinary(join(INSTALL_ROOT, "current")) } }),
      binary: PUBLISHED,
    },
  ];

  test("are the same string on every install kind: a checkout and a binary install, each with and without the PATH name", () => {
    for (const { kind, ctx, fs, binary } of kinds) {
      const skill = renderWalkySkill(ctx, fs, true);
      const reminder = fullReminder([{ id: "ak_abcdefghijkl", title: "Which colour?" }], resolveHookCommand(ctx, fs).binary);
      expect([kind, cancelBinary(skill)]).toEqual([kind, binary]);
      expect([kind, cancelBinary(reminder)]).toEqual([kind, binary]);
      expect([kind, skill.includes(`${binary} walky who`)]).toEqual([kind, true]);
    }
  });
});
