import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../json";

import { REPO_INDEX_ABOUT_MAX, REPO_INDEX_BYTES_MAX, REPO_INDEX_NAME_MAX, REPO_INDEX_TRICKS_MAX } from "./limits";
import { parseRepoIndex, readPhoneSource, readRepoAddReply, readRepoListReply, REPO_INDEX_TERMINAL_LINE, shownIndexText } from "./repo-index";

// The index file `collie-tricks.json` (package J): every rule refuses on its own, the phone's host list, and
// the repository's words as untrusted text.

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const doc = (tricks: readonly JsonValue[], extra: JsonObject = {}): Uint8Array => bytes(JSON.stringify({ contract: 1, tricks, ...extra }));
const entry = (over: JsonObject = {}): JsonObject => ({ folder: "idle-watch", name: "Idle Watch", about: "Marks a session that waits for you.", ...over });

function reason(input: Uint8Array): string {
  const read = parseRepoIndex(input);
  if (read.ok) throw new Error("expected a refusal");
  return read.reason;
}

describe("parseRepoIndex", () => {
  it("takes a well-formed index", () => {
    expect(parseRepoIndex(doc([entry(), entry({ folder: "lodge-board", name: "Lodge Board" })]))).toEqual({
      ok: true,
      index: {
        contract: 1,
        tricks: [
          { folder: "idle-watch", name: "Idle Watch", about: "Marks a session that waits for you." },
          { folder: "lodge-board", name: "Lodge Board", about: "Marks a session that waits for you." },
        ],
      },
    });
    expect(parseRepoIndex(doc([])).ok).toBe(true);
  });

  it("refuses each broken rule with one sentence", () => {
    expect(reason(bytes("not json"))).toBe("collie-tricks.json is not JSON.");
    expect(reason(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]))).toBe("collie-tricks.json is not UTF-8 text.");
    expect(reason(bytes("[]"))).toBe("collie-tricks.json is not a JSON object.");
    expect(reason(doc([], { extra: true }))).toBe('collie-tricks.json has a key Collie does not know: "extra".');
    expect(reason(bytes(JSON.stringify({ tricks: [] })))).toBe('collie-tricks.json needs "contract": 1.');
    expect(reason(bytes(JSON.stringify({ contract: "1", tricks: [] })))).toBe('collie-tricks.json needs "contract": 1.');
    expect(reason(bytes(JSON.stringify({ contract: 1 })))).toBe('collie-tricks.json needs "tricks", a list.');
    expect(reason(doc([entry({ why: 1 })]))).toBe('collie-tricks.json tricks[0] has a key Collie does not know: "why".');
    expect(reason(doc(["idle-watch"]))).toBe("collie-tricks.json tricks[0] is not an object.");
    expect(reason(doc([entry(), entry()]))).toBe("collie-tricks.json names the folder idle-watch twice.");
  });

  it("refuses a higher contract with one sentence", () => {
    expect(reason(bytes(JSON.stringify({ contract: 2, tricks: [] })))).toBe("collie-tricks.json is written for contract 2, and this Collie reads contract 1; update Collie to read it.");
  });

  it("refuses a folder that is not one trick-id step: .., /, a leading dot, upper case, empty, too long", () => {
    for (const folder of ["..", "../x", "a/b", "/abs", ".hidden", "-dash", "Idle", "", "a".repeat(33), "a b", "a\\b"]) {
      expect(reason(doc([entry({ folder })]))).toContain("tricks[0].folder is not a folder name Collie takes");
    }
  });

  it("holds name and about to their caps, one line, no control or invisible character", () => {
    expect(parseRepoIndex(doc([entry({ name: "n".repeat(REPO_INDEX_NAME_MAX), about: "a".repeat(REPO_INDEX_ABOUT_MAX) })])).ok).toBe(true);
    for (const name of ["n".repeat(REPO_INDEX_NAME_MAX + 1), "", " ", "Two\nlines", "Bell\u0007", "Flip\u202Eevil", "Zero\u200Bwidth", "Tag\u{E0041}"]) {
      expect(reason(doc([entry({ name })]))).toContain("tricks[0].name must be one line");
    }
    for (const about of ["a".repeat(REPO_INDEX_ABOUT_MAX + 1), "", "Two\r\nlines", "Isolate\u2066x"]) {
      expect(reason(doc([entry({ about })]))).toContain("tricks[0].about must be one line");
    }
  });

  it("holds the entry count and the file size", () => {
    const many = Array.from({ length: REPO_INDEX_TRICKS_MAX + 1 }, (_, i) => entry({ folder: `t${String(i)}` }));
    expect(reason(doc(many))).toBe(`collie-tricks.json lists ${String(REPO_INDEX_TRICKS_MAX + 1)} tricks, more than ${String(REPO_INDEX_TRICKS_MAX)}.`);
    expect(parseRepoIndex(doc(many.slice(0, REPO_INDEX_TRICKS_MAX))).ok).toBe(true);
    const padded = new Uint8Array(REPO_INDEX_BYTES_MAX + 1).fill(0x20);
    expect(reason(padded)).toBe("collie-tricks.json is larger than 32 KiB.");
  });

  it("shows an unknown key cut and cleaned, never as it is", () => {
    expect(reason(doc([], { ["k\u202E".repeat(30)]: 1 }))).toBe(`collie-tricks.json has a key Collie does not know: "${"k".repeat(30)}".`);
  });
});

describe("readPhoneSource", () => {
  it("takes github.com, gitlab.com and codeberg.org repository links, exactly", () => {
    expect(readPhoneSource("https://github.com/owner/repo")).toEqual({ url: "https://github.com/owner/repo", host: "github.com", repo: "owner/repo" });
    expect(readPhoneSource(" https://gitlab.com/group/sub/repo.git ")).toEqual({ url: "https://gitlab.com/group/sub/repo.git", host: "gitlab.com", repo: "group/sub/repo.git" });
    expect(readPhoneSource("https://codeberg.org/owner/repo")).toEqual({ url: "https://codeberg.org/owner/repo", host: "codeberg.org", repo: "owner/repo" });
  });

  it("answers every other host, an IP address and localhost with the terminal sentence", () => {
    for (const url of ["https://127.0.0.1/o/r", "https://[::1]/o/r", "https://10.0.0.7/o/r", "https://localhost/o/r", "https://github.com:8443/o/r", "https://GITHUB.COM/o/r", "https://github.com./o/r", "https://www.github.com/o/r", "https://git.example.test/o/r", "https://github.com.example.test/o/r"]) {
      expect(readPhoneSource(url)).toEqual({ code: "host", message: REPO_INDEX_TERMINAL_LINE });
    }
  });

  it("refuses credentials, another scheme, a query, a fragment and a path that is no repository", () => {
    expect(readPhoneSource("https://user:pw@github.com/o/r")).toEqual({ code: "invalid", message: "The link holds a user name or a password. Leave them out." });
    expect(readPhoneSource("https://token@github.com/o/r")).toEqual({ code: "invalid", message: "The link holds a user name or a password. Leave them out." });
    for (const url of ["http://github.com/o/r", "ssh://github.com/o/r", "git@github.com:o/r", "https://github.com/o/r?tab=1", "https://github.com/o/r#main", "https://github.com/o", "https://github.com/o/r/", "https://github.com/o/../r", "https://github.com/.o/r", `https://github.com/o/${"r".repeat(600)}`]) {
      const read = readPhoneSource(url);
      expect("code" in read && read.code).toBe("invalid");
    }
  });
});

describe("the repository's words as untrusted text", () => {
  it("drops control, direction and invisible characters, flattens lines, and cuts with an ellipsis", () => {
    expect(shownIndexText("Idle\u202E Watch\u0007", 40)).toBe("Idle Watch");
    expect(shownIndexText("one\nline\ttwo", 40)).toBe("one line two");
    expect(shownIndexText("abcdefghij", 5)).toBe("abcd…");
    expect(shownIndexText("<b>bold</b>", 40)).toBe("<b>bold</b>");
  });

  it("the phone's reader cleans and cuts a reply again and drops a reply of another shape", () => {
    const reply = readRepoListReply({
      rid: "r1",
      code: "ok",
      url: "https://github.com/owner/repo",
      host: "github.com",
      repo: "owner/repo",
      commit: "a".repeat(40),
      tricks: [{ folder: "idle-watch", name: `Idle\u2066${"x".repeat(60)}`, about: "Line\none", here: false }],
    });
    expect(reply?.tricks[0]?.name).toBe(`Idle${"x".repeat(35)}…`);
    expect(reply?.tricks[0]?.about).toBe("Line one");
    expect(readRepoListReply({ rid: "r1", code: "ok", url: "u", host: "h", repo: "r", commit: "a".repeat(40), tricks: [{ folder: "../x", name: "n", about: "a", here: false }] })).toBeUndefined();
    expect(readRepoListReply({ rid: "r1", code: "ok", url: "u", host: "h", repo: "r", commit: "HEAD", tricks: [] })).toBeUndefined();
    expect(readRepoAddReply({ rid: "r1", code: "ok", id: "idle-watch", hash: "b".repeat(64) })).toEqual({ rid: "r1", code: "ok", id: "idle-watch", hash: "b".repeat(64) });
    expect(readRepoAddReply({ rid: "r1", code: "ok", id: "Idle", hash: "b".repeat(64) })).toBeUndefined();
  });
});
