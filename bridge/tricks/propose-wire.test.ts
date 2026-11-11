import { describe, expect, test } from "bun:test";

import { ADD_LIMITS } from "../../cli/trick-add.ts";
import type { JsonObject } from "../json.ts";
import { checkProposedFiles, foldKey, proposalHash, proposedPathProblem, PROPOSE_LIMITS, readProposal, RESERVED_PROPOSAL_IDS, wireFiles, type ProposedFile } from "./propose-wire.ts";

// THE ONE READER OF A PROPOSAL'S FILES (crew slice 8): the CLI, the member and the lead all read with it,
// and the lead treats every byte as hostile. Each refusal below is one a hostile member could try.

const RID = "11111111-2222-4333-8444-555555555555";
const MANIFEST = 'id = "legs"\nname = "Browser leg"\nrun = "program.ts"\nplaces = ["belt"]\ncontract = 1\n';
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function file(rel: string, text = "x", executable = false): ProposedFile {
  return { rel, bytes: enc(text), executable };
}

function base(): ProposedFile[] {
  return [file("trick.toml", MANIFEST), file("program.ts", "console.log(1)\n")];
}

function wire(files: readonly ProposedFile[], extra: JsonObject = {}): JsonObject {
  return { requestId: RID, files: wireFiles(files), ...extra };
}

function refusedWith(fields: JsonObject): string {
  const read = readProposal(fields);
  if (read.ok) throw new Error("expected a refusal");
  return read.refusal.error;
}

describe("the paths a proposal may carry", () => {
  test.each([
    ["../escape.ts", "has a . or .. step"],
    ["a/../../b.ts", "has a . or .. step"],
    ["./a.ts", "has a . or .. step"],
    ["/etc/passwd", "is an absolute path"],
    ["a//b.ts", "has an empty step"],
    [".env", "dot file"],
    ["lib/.git/config", "dot file"],
    [".collie-approved/x/y", "dot file"],
    ["node_modules/x.js", "node_modules"],
    ["inputs/a.md", "inputs/"],
    ["run.log", ".log"],
    ["sub/run.log", ".log"],
    ["a\\b.ts", "backslash"],
    ["c:/x.ts", "colon"],
    ["a\u0000b.ts", "control"],
    ["a\nb.ts", "control"],
    ["evil\u202Egnp.ts", "direction"],
    ["zero\u200Bwidth.ts", "invisible"],
    ["cafe\u0301.ts", "NFC"],
    [`${"a/".repeat(9)}x.ts`, "deeper"],
    ["x".repeat(257), "longer than"],
  ])("%p is refused (%s)", (rel, words) => {
    expect(proposedPathProblem(rel)).toContain(words);
    expect(refusedWith(wire([...base(), file(rel)]))).toContain(words);
  });

  test.each([
    ["Inputs/a.md", "inputs/"],
    ["INPUTS/a.md", "inputs/"],
    ["NODE_MODULES/x.js", "node_modules"],
    ["lib/Node_Modules/x.js", "node_modules"],
  ])("a reserved name in another case is refused too: %p", (rel, words) => {
    expect(proposedPathProblem(rel)).toContain(words);
  });

  test("a picture folder in another case keeps the picture rule", () => {
    expect(refusedWith(wire([...base(), file("Media/run.ts", "code")]))).toContain("picture folder");
    expect(refusedWith(wire([...base(), file("CAPTURES/x.png", "#!/bin/sh")]))).toContain("picture folder");
  });

  test("ordinary names, a nested folder and config.toml are taken", () => {
    for (const rel of ["program.ts", "lib/util.ts", "config.toml", "README.md", "a-b_c.d.ts"]) expect(proposedPathProblem(rel)).toBeNull();
  });

  test("names that fold to one are refused: case, Unicode compatibility forms", () => {
    expect(refusedWith(wire([...base(), file("Util.ts"), file("util.ts")]))).toContain("once case and Unicode form are set aside");
    // U+FB01 LATIN SMALL LIGATURE FI is NFC, and NFKC folds it to "fi".
    expect(foldKey("\uFB01le.ts")).toBe("file.ts");
    expect(refusedWith(wire([...base(), file("file.ts"), file("\uFB01le.ts")]))).toContain("once case and Unicode form are set aside");
    expect(refusedWith(wire([...base(), file("lib/a.ts"), file("LIB/b.ts")]))).toContain("Two folders");
  });

  test("the same name twice, and a name used as a file and as a folder, are refused", () => {
    expect(refusedWith(wire([...base(), file("a.ts"), file("a.ts")]))).toContain("set aside");
    expect(refusedWith(wire([...base(), file("lib"), file("lib/a.ts")]))).toContain("as a file and as a folder");
  });

  test("media/ and captures/ carry pictures only, by name and by their first bytes", () => {
    expect(readProposal(wire([...base(), { rel: "media/a.png", bytes: PNG, executable: false }])).ok).toBe(true);
    expect(refusedWith(wire([...base(), file("media/run.ts", "code")]))).toContain("picture folder");
    expect(refusedWith(wire([...base(), file("captures/fake.png", "#!/bin/sh")]))).toContain("picture folder");
  });
});

describe("the caps", () => {
  test("are the caps of collie trick add", () => {
    expect(PROPOSE_LIMITS.files).toBe(ADD_LIMITS.files);
    expect(PROPOSE_LIMITS.bytes).toBe(ADD_LIMITS.bytes);
    expect(PROPOSE_LIMITS.depth).toBe(ADD_LIMITS.depth);
  });

  test("too many files is refused before a byte is decoded", () => {
    const many = Array.from({ length: PROPOSE_LIMITS.files + 1 }, (_, i) => ({ rel: `f${String(i)}.ts`, b64: "!!!not base64" }));
    expect(refusedWith({ requestId: RID, files: many })).toContain(`more than ${String(PROPOSE_LIMITS.files)}`);
  });

  test("too many bytes is refused, by the base64 length before decoding and by the bytes after", () => {
    const big = "A".repeat(Math.ceil(PROPOSE_LIMITS.bytes / 3) * 4 + 8);
    expect(refusedWith({ requestId: RID, files: [{ rel: "big.bin", b64: big }] })).toContain("more than 5 MB");
    const half = new Uint8Array(PROPOSE_LIMITS.bytes / 2 + 1);
    expect(refusedWith(wire([...base(), { rel: "a.bin", bytes: half, executable: false }, { rel: "b.bin", bytes: half, executable: false }]))).toContain("more than 5 MB");
  });

  test("a manifest over 64 KiB is refused", () => {
    expect(refusedWith(wire([file("trick.toml", `${MANIFEST}# ${"x".repeat(70_000)}\n`)]))).toContain("larger than 64 KiB");
  });
});

describe("the shape and the manifest", () => {
  test("a request id, a list of { rel, b64, x? } and standard base64 only", () => {
    expect(refusedWith({ requestId: "nope", files: [] })).toContain("request id");
    expect(refusedWith({ requestId: RID, files: "x" })).toContain("list");
    expect(refusedWith({ requestId: RID, files: [{ rel: "a.ts", b64: "eA==", mode: 777 }] })).toContain("{ rel, b64, x? }");
    expect(refusedWith({ requestId: RID, files: [{ rel: "trick.toml", b64: "eA" }] })).toContain("not standard base64");
    expect(refusedWith({ requestId: RID, files: [] })).toContain("holds no file");
  });

  test("trick.toml is required, read strictly, and names an id that is not Collie's own word", () => {
    expect(refusedWith(wire([file("program.ts")]))).toContain("There is no trick.toml");
    expect(refusedWith(wire([file("trick.toml", 'id = "../x"\n')]))).toContain("names no trick id");
    expect(refusedWith(wire([file("trick.toml", `${MANIFEST}bogus = 1\n`)]))).toContain("trick.toml");
    for (const id of RESERVED_PROPOSAL_IDS) {
      expect(refusedWith(wire([file("trick.toml", MANIFEST.replace('id = "legs"', `id = "${id}"`))]))).toContain("keeps for itself");
    }
  });

  test("a good proposal reads back sorted, with its manifest and its hash", () => {
    const read = readProposal(wire([file("program.ts", "1", true), file("trick.toml", MANIFEST)]));
    if (!read.ok) throw new Error(read.refusal.error);
    expect(read.proposal.files.map((f) => f.rel)).toEqual(["program.ts", "trick.toml"]);
    expect(read.proposal.files[0]?.executable).toBe(true);
    expect(read.proposal.manifest.id).toBe("legs");
    expect(read.proposal.hash).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("the hash", () => {
  test("is the same in any order, and moves with a byte, a name or the executable mark", () => {
    const one = proposalHash([file("a", "1"), file("b", "2")]);
    expect(proposalHash([file("b", "2"), file("a", "1")])).toBe(one);
    expect(proposalHash([file("a", "1"), file("b", "3")])).not.toBe(one);
    expect(proposalHash([file("a", "1"), file("c", "2")])).not.toBe(one);
    expect(proposalHash([file("a", "1", true), file("b", "2")])).not.toBe(one);
  });

  test("checkProposedFiles agrees with readProposal on what it takes", () => {
    expect(checkProposedFiles(base()).ok).toBe(true);
    expect(checkProposedFiles([...base(), file("../x")]).ok).toBe(false);
  });
});
