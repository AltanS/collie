import { describe, expect, test } from "bun:test";

import { MORPH_SKILL_TEMPLATE } from "./docs-embed.ts";
import { morphClosedSetLines, morphHelp, morphKindLines, MORPH_RULES, morphUsageLines } from "./morph.ts";
import { morphRulesId, morphRulesSource, renderMorphSkillText, rulesIdOf } from "./morph-skill.ts";

// The Morph skill's text and its rules id (cli/morph-skill.ts). The skill and `morph help` are built from
// the same constants, and the id is a hash of both with the binary, the version and the id left out.

const BIN = "/home/op/apps/collie/bin/collie";
const render = (binary = BIN, version = "1.28.1"): string => renderMorphSkillText({ binary, version });

describe("the rendered Morph skill", () => {
  test("fills every placeholder: front matter, the binary, the id, and its own stamp last", () => {
    const out = render();
    expect(out).not.toContain("{{");
    expect(out.startsWith("---\nname: collie-morph\n")).toBe(true);
    expect(out).toContain(`${BIN} morph start --session <session> --rules ${morphRulesId()} "<3 to 6 words on what you are doing>"`);
    expect(out).toContain(`The rules id of this text is \`${morphRulesId()}\`.`);
    expect(out.trimEnd().split("\n").at(-1)).toBe("<!-- collie-skill morph v1 collie 1.28.1 -->");
    expect(MORPH_SKILL_TEMPLATE.trimEnd().split("\n").at(-1)).toBe("<!-- collie-skill morph v1 collie {{COLLIE_VERSION}} -->");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  test("when it applies, the head form, and the tail it makes needless", () => {
    const out = render();
    expect(out).toContain('Use it when a prompt starts with "[morph " and holds "] from operator:"');
    expect(out).toContain("[morph collie-04rj6a/w54:p1B#sx56] from operator:");
    expect(out).toContain("You need not run it");
  });

  test("the rules, the kinds, the closed sets and every verb's usage are help's own lines", () => {
    const out = render();
    const help = morphHelp().join("\n");
    for (const rule of MORPH_RULES.filter((line) => line.startsWith("- "))) {
      expect(out).toContain(rule);
      expect(help).toContain(rule);
    }
    for (const line of [...morphKindLines(), ...morphClosedSetLines()]) expect(out).toContain(line);
    for (const line of morphUsageLines(BIN)) expect(out).toContain(line.trim());
    for (const words of ["`morph pending", "`morph keep", "--image", "/tmp", "one decision per screen", '"preview" picture', "Chat is the record", "in the operator's name"]) {
      expect(out).toContain(words);
    }
  });

  test("no em dash in the text an agent reads", () => {
    expect(render()).not.toContain("—");
  });
});

describe("the rules id", () => {
  test("is 8 hex characters, the hash of the rules source, and the same on every call", () => {
    expect(morphRulesId()).toMatch(/^[0-9a-f]{8}$/u);
    expect(morphRulesId()).toBe(rulesIdOf(morphRulesSource()));
    expect(morphRulesId()).toBe(morphRulesId());
  });

  test("the source holds no binary, no version and no id: another path or release keeps the id", () => {
    const source = morphRulesSource();
    expect(source).toContain("{{COLLIE_BIN}} morph start");
    expect(source).toContain("{{COLLIE_VERSION}}");
    expect(source).not.toContain(morphRulesId());
    const a = render("/a/bin/collie", "1.0.0");
    const b = render("/elsewhere/bin/collie", "9.9.9");
    expect(a.replaceAll("/a/bin/collie", "X").replace("1.0.0", "V")).toBe(b.replaceAll("/elsewhere/bin/collie", "X").replace("9.9.9", "V"));
  });

  test("any change to the rules text changes the id: the skill's words and the help's alike", () => {
    const source = morphRulesSource();
    const rule = MORPH_RULES[2]!;
    expect(source.split(rule).length - 1).toBe(2);
    expect(rulesIdOf(source.replace(rule, `${rule} `))).not.toBe(morphRulesId());
    expect(rulesIdOf(source.replace("ok, muted", "ok"))).not.toBe(morphRulesId());
    expect(rulesIdOf(`${source}\n`)).not.toBe(morphRulesId());
  });
});
