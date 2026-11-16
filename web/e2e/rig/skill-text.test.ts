import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { renderSkillTemplate } from "../../../cli/skill-render";
import { writeWalkySkill } from "./harnesses";
import { renderRigSkill, rigSkillText, skillHash, SKILL_TEMPLATE } from "./replay/skill-text";
import { skillHash as tierSkillHash } from "./replay/tier";

// The skill the rig's agents read, and the recording key made from it. An agent in the rig reads what a
// default install gives: the product's render with the Hill switch off.

const template = (): string => readFileSync(SKILL_TEMPLATE, "utf8").replaceAll("\r\n", "\n");
/** The first line of the template's Hill part (a marker line) and the first word-level marker, to edit inside them. */
const HILL_OPEN = "{{HILL}}\n";
const HILL_CLOSE = "{{/HILL}}\n";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "rig-skill-"));
  dirs.push(dir);
  return dir;
};

describe("the text the rig writes", () => {
  test("holds no Hill marker and no Hill section, in the file form and in the block form", () => {
    const dir = scratch();
    writeWalkySkill(join(dir, "SKILL.md"), "file");
    writeWalkySkill(join(dir, "AGENTS.md"), "block");
    for (const name of ["SKILL.md", "AGENTS.md"]) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text).not.toContain("{{HILL");
      expect(text).not.toContain("{{/HILL");
      expect(text).not.toContain("{{COLLIE_");
      expect(text).not.toContain("Decisions (the hill)");
      expect(text).not.toMatch(/hill Decisions and/u);
    }
  });

  test("the file form is the product's off render, with the command `collie` and the version `rig`", () => {
    const dir = scratch();
    writeWalkySkill(join(dir, "SKILL.md"), "file");
    const expected = renderSkillTemplate(template(), { binary: "collie", version: "rig", hillOn: false });
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(expected);
    expect(rigSkillText()).toBe(expected);
  });

  test("the template really has a Hill part, and the on render keeps it and the off render does not", () => {
    expect(template()).toContain(HILL_OPEN);
    const on = renderRigSkill(template(), true);
    const off = renderRigSkill(template(), false);
    expect(on).toContain("Decisions (the hill)");
    expect(on).not.toContain("{{HILL");
    expect(off).not.toContain("Decisions (the hill)");
    expect(off.length).toBeLessThan(on.length);
  });
});

describe("the recording key", () => {
  test("is the hash of the text the agents read, and tier.ts uses the same function", () => {
    expect(skillHash()).toMatch(/^[0-9a-f]{16}$/u);
    expect(tierSkillHash()).toBe(skillHash());
    expect(skillHash()).toBe(skillHash(rigSkillText()));
  });

  test("changes when the off text changes", () => {
    const base = template();
    const edited = base.replace("# ", "# (changed) ");
    expect(edited).not.toBe(base);
    expect(skillHash(renderRigSkill(edited, false))).not.toBe(skillHash(renderRigSkill(base, false)));
  });

  test("does not change when only text inside the Hill part changes", () => {
    const base = template();
    const open = base.indexOf(HILL_OPEN);
    const close = base.indexOf(HILL_CLOSE);
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    const edited = `${base.slice(0, open + HILL_OPEN.length)}A new Hill-only line the agents never read.\n${base.slice(open + HILL_OPEN.length)}`;
    expect(edited).not.toBe(base);
    expect(skillHash(renderRigSkill(edited, false))).toBe(skillHash(renderRigSkill(base, false)));
    // The one-line Hill words in the description cut the same way.
    const words = base.replace("{{HILL}}", "{{HILL}}extra words ");
    expect(words).not.toBe(base);
    expect(skillHash(renderRigSkill(words, false))).toBe(skillHash(renderRigSkill(base, false)));
  });

  test("holds no machine path and no build version", () => {
    const text = rigSkillText();
    expect(text).not.toContain(process.cwd());
    expect(text).toContain("collie walky");
    expect(text).toContain("collie rig -->");
  });
});
