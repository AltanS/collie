import { describe, expect, test } from "bun:test";

import { DECLARED, OPERATION_NAMES } from "../bridge/api/operations.ts";
import { apiHelp, cmdApi, declaredOperations, flagOf, RUN_ONLY, type CliOperation } from "./api.ts";
import { capture } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { run } from "./program.ts";

// `collie api` (M105 spec 03, decision 19; spec 05, decision 6): the help is generated from the operation
// table, and in this release an operation run by hand prints one line, reads nothing and exits STATE,
// because the local API answers a trick's own run (a run token in its facts) and nothing else.

const FAKE: readonly CliOperation[] = [
  ...declaredOperations(),
  {
    name: "tally",
    summary: "A made-up operation for the test.",
    args: [
      { name: "workshop", type: "string", required: true, help: "The workshop to count." },
      { name: "maxItems", type: "integer", required: false, help: "How many to count." },
    ],
  },
];

describe("generated from the table", () => {
  test("the operations are the table's, in its order", () => {
    expect(declaredOperations().map((one) => one.name)).toEqual([...OPERATION_NAMES]);
    for (const name of OPERATION_NAMES) expect(declaredOperations().find((one) => one.name === name)).toBe(DECLARED[name]);
  });

  test("the help lists every operation with its summary and its flags, says experimental, and says who it answers", () => {
    const text = apiHelp(declaredOperations()).join("\n");
    expect(text).toContain("Experimental");
    expect(text).toContain("It answers a trick's own run in this release");
    for (const name of OPERATION_NAMES) {
      expect(text).toContain(name);
      expect(text).toContain(DECLARED[name].summary);
      for (const arg of DECLARED[name].args) expect(text).toContain(`${flagOf(arg.name)} <`);
    }
    expect(text).toContain("--token <text>  (required)");
    expect(text).not.toContain("--client");
    expect(text).toContain("--session <text>");
    expect(text).toContain("--lines <number>");
  });

  test("a row added to the table appears in the help with its flags, with no change to the verb", () => {
    const text = apiHelp(FAKE).join("\n");
    expect(text).toContain("tally");
    expect(text).toContain("--workshop <text>  (required) The workshop to count.");
    expect(text).toContain("--max-items <number>");
  });

  test("a flag is the argument name in kebab case", () => {
    expect(flagOf("session")).toBe("--session");
    expect(flagOf("maxItems")).toBe("--max-items");
  });

  test("bare `collie api` and `collie api --help` print the same generated list and exit 0", async () => {
    const bare = capture();
    expect(await run(["api"], bare)).toBe(EXIT.OK);
    const asked = capture();
    expect(await run(["api", "--help"], asked)).toBe(EXIT.OK);
    expect(bare.stdout).toEqual(apiHelp(declaredOperations()));
    expect(asked.stdout).toEqual(bare.stdout);
    expect(bare.stderr).toEqual([]);
  });
});

describe("by hand, in this release", () => {
  test("every operation prints the one line and exits STATE, whatever its flags", () => {
    for (const argv of [["hello"], ["sessions", "--json"], ["read", "--session", "ses_x", "--lines", "abc"], ["events", "--wait", "25"], ["machines"]]) {
      const io = capture();
      expect(cmdApi({ io, operations: FAKE }, argv)).toBe(EXIT.STATE);
      expect(io.stderr).toEqual([RUN_ONLY]);
      expect(io.stdout).toEqual([]);
    }
    expect(RUN_ONLY).toBe("The local API answers a trick's own run in this release. A trick reads it with t.api.");
  });

  test("through `run`, the same line and exit 3, and no socket is looked for", async () => {
    const io = capture();
    expect(await run(["api", "sessions"], io)).toBe(EXIT.STATE);
    expect(io.stderr).toEqual([RUN_ONLY]);
  });

  test("an unknown operation is a usage error that names the operations", () => {
    const io = capture();
    expect(cmdApi({ io }, ["send"])).toBe(EXIT.USAGE);
    expect(io.stderr[0]).toBe("error: unknown operation `send`");
    expect(io.stderr[1]).toContain("hello|sessions|brief|read|accounts|hill.list|machines|events");
  });
});
