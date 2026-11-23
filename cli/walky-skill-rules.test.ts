import { describe, expect, test } from "bun:test";

import { WALKY_TALKY_SKILL_TEMPLATE } from "./docs-embed.ts";

// The recipient rules of the skill (the pick tests of 2026-11-23): a short key phrase of each, never a
// whole paragraph, so a reword that keeps the rule stays green and a dropped rule goes red. A paragraph
// wraps across lines, so the template is compared with its line breaks turned into spaces.
const flat = WALKY_TALKY_SKILL_TEMPLATE.replace(/\n\s*/gu, " ");

describe("the skill keeps an agent from sending to the wrong session", () => {
  test("rule 1: a stale address from a note is never repaired by swapping its token", () => {
    expect(flat).toContain("Never swap the token and send.");
    expect(flat).toContain("send to the address `who` prints");
    expect(flat).toContain("send nothing and ask your operator");
  });

  test("rule 2: a NAME matches only as a whole name, or with a short mark of its space", () => {
    expect(flat).toContain("or the NAME with a short mark of its space in front");
    expect(flat).toContain("A NAME that only holds the word among others");
    expect(flat).toContain("No match: ask your operator, and name the rows you saw.");
  });

  test("rule 3: the lead with no space named is the lead of the agent's own space", () => {
    expect(flat).toContain('"The lead", with no space named, is the lead of YOUR space.');
  });

  test("rule 4: --outside only when the operator named the space or gave the address", () => {
    expect(flat).toContain("they named the other space or gave you the address");
    expect(flat).toContain("tell your operator which session you found and where, and stop");
    expect(flat).toContain("Never add `--outside` on your own.");
  });

  test("rule 5: the newest message from an agent is answered with reply, also in the middle of an exchange", () => {
    expect(flat).toContain("Answer the newest message from an agent with `reply <its id>`, also in the middle of an exchange with another session");
    expect(flat).toContain("an address you wrote to before is not the sender of this message");
    expect(flat).toContain("`send` is only for a message you start");
  });

  test("send prints who got the message, and names a message that waits for a reply", () => {
    expect(flat).toContain("`to: <NAME> · <SPACE> · <MACHINE>`, the session that got it");
    expect(flat).toContain("if it is not the session you meant, tell your operator");
    expect(flat).toContain("A `note: <id> from <NAME> is not answered` line");
  });

  test("the skill still has no em dash", () => {
    expect(WALKY_TALKY_SKILL_TEMPLATE).not.toContain("—");
  });
});
