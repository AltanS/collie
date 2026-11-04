import { describe, expect, test } from "bun:test";

import { CANDIDATE_TIMEOUT_MS, type HostCandidate, type HostProbe } from "../bridge/mux/host-candidates.ts";
import {
  blockedReason,
  hostRefusal,
  markCandidates,
  mergeCandidates,
  offeredCandidates,
  parseResolvedSshTarget,
  pickCandidates,
  refusedToken,
  renderCandidateList,
  resolvedSshTarget,
  screenCandidates,
  splitSshTarget,
  sshResolveArgs,
  SSH_CONFIG_SOURCE,
  type SourcedCandidates,
} from "./candidates.ts";

// The merge, the mark and the rendering, over a probe that records rather than spawns. **NOTHING
// here runs `ssh`.**

const named = (target: string): HostCandidate => ({ target, label: null, id: null, blocked: null });
const blockedNamed = (target: string, reason: string): HostCandidate => ({ target, label: null, id: null, blocked: reason });

/** `ssh -G`'s output, as ssh prints it: one lowercase keyword per line. */
function resolved(user: string, hostname: string, port: string): string {
  return [`user ${user}`, `hostname ${hostname}`, `port ${port}`, "addkeystoagent false"].join("\n");
}

/** A probe that records every spawn and answers `ssh -G` from the test's own table. */
interface Rig {
  probe: HostProbe;
  spawns: string[];
}

function probeFor(table: Readonly<Record<string, string>>): Rig {
  const spawns: string[] = [];
  const probe: HostProbe = {
    run: (tool, args, timeoutMs) => {
      spawns.push([tool, ...args].join(" "));
      expect(timeoutMs).toBe(CANDIDATE_TIMEOUT_MS);
      const answer = table[[tool, ...args].join(" ")];
      if (answer === undefined) return { code: 1, stdout: "", stderr: "no such host", found: true };
      return { code: 0, stdout: answer, stderr: "", found: true };
    },
    warn: () => {},
  };
  return { probe, spawns };
}

describe("splitSshTarget", () => {
  test("host, user@host and user@host:port", () => {
    expect(splitSshTarget("attic")).toEqual({ user: null, host: "attic", port: null });
    expect(splitSshTarget("op@attic.lan")).toEqual({ user: "op", host: "attic.lan", port: null });
    expect(splitSshTarget("op@attic.lan:2222")).toEqual({ user: "op", host: "attic.lan", port: "2222" });
  });

  test("an IPv6 literal is full of colons and carries no port", () => {
    expect(splitSshTarget("fd00::1")).toEqual({ user: null, host: "fd00::1", port: null });
    expect(splitSshTarget("op@[fd00::1]:2222")).toEqual({ user: "op", host: "fd00::1", port: "2222" });
  });
});

describe("sshResolveArgs", () => {
  test("a port leaves the destination and becomes -p, because ssh never took host:port", () => {
    expect(sshResolveArgs("attic")).toEqual(["-G", "--", "attic"]);
    expect(sshResolveArgs("op@attic.lan:2222")).toEqual(["-G", "-p", "2222", "--", "op@attic.lan"]);
  });
});

describe("parseResolvedSshTarget", () => {
  test("user, hostname and port, first occurrence winning", () => {
    expect(parseResolvedSshTarget(`${resolved("op", "attic.lan", "22")}\nhostname other`)).toBe("op@attic.lan:22");
  });

  test("output without a hostname is not a merge key", () => {
    expect(parseResolvedSshTarget("user op\nport 22")).toBeNull();
    expect(parseResolvedSshTarget("")).toBeNull();
  });
});

describe("resolvedSshTarget", () => {
  test("it runs `ssh -G` and nothing else, under the shared budget", () => {
    const { probe, spawns } = probeFor({ "ssh -G -- attic": resolved("op", "attic.lan", "22") });
    expect(resolvedSshTarget("attic", probe)).toBe("op@attic.lan:22");
    expect(spawns).toEqual(["ssh -G -- attic"]);
  });

  test("no ssh, a refusal or unreadable output all mean the same thing: unresolved", () => {
    const absent: HostProbe = {
      run: () => ({ code: 127, stdout: "", stderr: "", found: false }),
      warn: () => {},
    };
    expect(resolvedSshTarget("attic", absent)).toBeNull();
    const { probe } = probeFor({});
    expect(resolvedSshTarget("attic", probe)).toBeNull();
  });
});

describe("mergeCandidates", () => {
  const sources: readonly SourcedCandidates[] = [
    { source: SSH_CONFIG_SOURCE, candidates: [named("attic"), named("build-box")] },
    { source: "herdr", candidates: [named("op@attic.lan:22"), named("nas")] },
  ];

  test("two sources naming one machine under two aliases produce ONE row", () => {
    const rows = mergeCandidates(sources, (target) =>
      target === "attic" || target === "op@attic.lan:22" ? "op@attic.lan:22" : null,
    );
    expect(rows).toHaveLength(3);
    const attic = rows[0]!;
    expect(attic.target).toBe("attic");
    expect(attic.names).toEqual(["attic", "op@attic.lan:22"]);
    expect(attic.sources).toEqual(["ssh config", "herdr"]);
  });

  test("the ssh-config spelling leads the row, because that list is the one kept by hand", () => {
    const rows = mergeCandidates(sources, () => "one-machine");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toBe("attic");
  });

  test("with no resolution the alias as typed is the key, so two aliases stay two rows", () => {
    const rows = mergeCandidates(sources, () => null);
    expect(rows.map((r) => r.target)).toEqual(["attic", "build-box", "op@attic.lan:22", "nas"]);
    expect(rows.map((r) => r.sources.join(","))).toEqual(["ssh config", "ssh config", "herdr", "herdr"]);
  });

  test("resolution is asked once per distinct target, never once per source", () => {
    const asked: string[] = [];
    mergeCandidates(sources, (target) => {
      asked.push(target);
      return null;
    });
    expect(asked).toEqual(["attic", "build-box", "op@attic.lan:22", "nas"]);
  });

  test("a label survives the merge from whichever source carried one", () => {
    const rows = mergeCandidates(
      [
        { source: SSH_CONFIG_SOURCE, candidates: [named("attic")] },
        { source: "herdr", candidates: [{ target: "op@attic.lan:22", label: "The attic", id: "m-1", blocked: null }] },
      ],
      () => "one",
    );
    expect(rows[0]!.label).toBe("The attic");
  });
});

describe("markCandidates", () => {
  const rows = mergeCandidates(
    [{ source: SSH_CONFIG_SOURCE, candidates: [named("attic"), named("nas")] }],
    (target) => (target === "attic" ? "op@attic.lan:22" : null),
  );

  test("a member is joined on the resolved key, so two spellings still meet", () => {
    const marked = markCandidates(rows, [{ memberId: "attic-1", sshHost: "10.0.0.9", key: "op@attic.lan:22" }]);
    expect(marked[0]!.memberId).toBe("attic-1");
    expect(marked[1]!.memberId).toBeNull();
  });

  test("and on the recorded destination verbatim, which is what answers with no resolution", () => {
    const marked = markCandidates(rows, [{ memberId: "nas", sshHost: "nas", key: "nas" }]);
    expect(marked[1]!.memberId).toBe("nas");
  });

  test("an empty roster marks nothing", () => {
    expect(markCandidates(rows, []).every((row) => row.memberId === null)).toBe(true);
  });

  test("a member with no recorded route MAY be the row on the host of its trust-store address", () => {
    const resolvedRows = mergeCandidates(
      [{ source: "herdr-core", candidates: [named("op@lab-two"), named("op@192.168.77.3")] }],
      (target) => (target === "op@lab-two" ? "op@192.168.77.2:22" : null),
    );
    const marked = markCandidates(resolvedRows, [
      { memberId: "box", sshHost: null, key: null, addressHost: "192.168.77.2" },
      { memberId: "omarchy", sshHost: null, key: null, addressHost: "192.168.77.3" },
    ]);
    // The first through ssh -G's hostname, the second through the host part of the target as typed.
    // Neither is a route, so neither row is "in this crew": each is only annotated.
    expect(marked.map((row) => row.memberId)).toEqual([null, null]);
    expect(marked.map((row) => row.maybeMemberIds)).toEqual([["box"], ["omarchy"]]);
    expect(offeredCandidates(marked)).toHaveLength(2);
  });

  test("an IPv6 address host meets a bracketed target and a resolved hostname alike", () => {
    const v6 = mergeCandidates(
      [{ source: "herdr-core", candidates: [named("op@[fd00::2]:22"), named("v6-alias")] }],
      (target) => (target === "v6-alias" ? "op@fd00::3:22" : null),
    );
    const marked = markCandidates(v6, [
      { memberId: "two", sshHost: null, key: null, addressHost: "fd00::2" },
      { memberId: "three", sshHost: null, key: null, addressHost: "fd00::3" },
    ]);
    expect(marked.map((row) => row.maybeMemberIds)).toEqual([["two"], ["three"]]);
  });

  test("and on its member id, case-insensitively, against the label and the target's host, never as a certainty", () => {
    const labelled = mergeCandidates(
      [
        {
          source: "herdr-core",
          candidates: [
            { target: "op@192.168.77.9", label: "Member", id: null, blocked: null },
            named("op@Attic"),
            named("op@vps"),
          ],
        },
      ],
      () => null,
    );
    const marked = markCandidates(labelled, [
      { memberId: "member", sshHost: null, key: null, addressHost: "10.0.0.1" },
      { memberId: "attic", sshHost: null, key: null, addressHost: null },
    ]);
    expect(marked.map((row) => row.memberId)).toEqual([null, null, null]);
    expect(marked.map((row) => row.maybeMemberIds)).toEqual([["member"], ["attic"], []]);
  });

  // ── A WEAK MATCH NEVER HIDES A PICK (M84 hardening) ───────────────────────────
  // The row carries no certificate and this module dials nothing, so an address host or a member id
  // cannot be told apart from another machine's. Only the recorded route marks a row.

  test("two peers that share an address host on different ports mark neither row as in the crew", () => {
    const shared = mergeCandidates([{ source: "herdr-core", candidates: [named("op@gateway")] }], () => null);
    const marked = markCandidates(shared, [
      { memberId: "lab-a", sshHost: null, key: null, addressHost: "gateway" },
      { memberId: "lab-b", sshHost: null, key: null, addressHost: "gateway" },
    ]);
    expect(marked[0]!.memberId).toBeNull();
    // Both are named, so the operator sees the ambiguity instead of one of them being picked for them.
    expect(marked[0]!.maybeMemberIds).toEqual(["lab-a", "lab-b"]);
    expect(offeredCandidates(marked)).toHaveLength(1);
    expect(renderCandidateList(marked).join("\n")).toContain('may be enrolled as "lab-a", "lab-b"');
    expect(renderCandidateList(marked).join("\n")).not.toContain("already enrolled");
  });

  test("a name that equals an old member id does not mark a machine at another address", () => {
    const renamed = mergeCandidates(
      [{ source: "herdr-core", candidates: [{ target: "op@198.51.100.7", label: "minibuch", id: null, blocked: null }] }],
      () => null,
    );
    const marked = markCandidates(renamed, [
      { memberId: "minibuch", sshHost: null, key: null, addressHost: "100.64.0.8" },
    ]);
    expect(marked[0]!.memberId).toBeNull();
    expect(offeredCandidates(marked).map((row) => row.target)).toEqual(["op@198.51.100.7"]);
  });

  test("a weakly matched row is numbered and nameable, but `all` leaves it out", () => {
    const two = mergeCandidates(
      [{ source: "herdr-core", candidates: [named("op@gateway"), named("op@vps")] }],
      () => null,
    );
    const marked = markCandidates(two, [{ memberId: "lab-a", sshHost: null, key: null, addressHost: "gateway" }]);
    expect(pickCandidates(marked, "all")!.map((row) => row.target)).toEqual(["op@vps"]);
    expect(pickCandidates(marked, "1")!.map((row) => row.target)).toEqual(["op@gateway"]);
    expect(pickCandidates(marked, "op@gateway")!.map((row) => row.target)).toEqual(["op@gateway"]);
  });

  test("a recorded route wins over another member's address or id", () => {
    const one = mergeCandidates([{ source: SSH_CONFIG_SOURCE, candidates: [named("nas")] }], () => "op@nas.lan:22");
    const marked = markCandidates(one, [
      { memberId: "nas", sshHost: null, key: null, addressHost: "nas.lan" },
      { memberId: "nas-2", sshHost: "nas-alias", key: "op@nas.lan:22" },
    ]);
    expect(marked[0]!.memberId).toBe("nas-2");
  });

  test("a marked row is not offered", () => {
    const marked = markCandidates(rows, [{ memberId: "nas", sshHost: "nas", key: "nas" }]);
    expect(offeredCandidates(marked).map((r) => r.target)).toEqual(["attic"]);
  });
});

describe("renderCandidateList", () => {
  const rows = markCandidates(
    mergeCandidates(
      [
        { source: SSH_CONFIG_SOURCE, candidates: [named("attic"), named("build-box"), named("nas")] },
        { source: "herdr", candidates: [named("op@attic.lan:22")] },
      ],
      (target) => (target === "attic" || target === "op@attic.lan:22" ? "op@attic.lan:22" : null),
    ),
    [{ memberId: "nas-1", sshHost: "nas", key: "nas" }],
  );

  test("every row states its source, and the mark is a separate column", () => {
    expect(renderCandidateList(rows)).toEqual([
      "Candidate hosts on this machine:",
      "",
      "   1  attic      ssh config, herdr  also op@attic.lan:22",
      "   2  build-box  ssh config",
      "      nas        ssh config  already enrolled as \"nas-1\"",
      "",
    ]);
  });

  test("an already-enrolled row keeps its place and loses its number", () => {
    const lines = renderCandidateList(rows);
    expect(lines.filter((l) => l.includes("nas ")).join()).not.toMatch(/^\s+\d/u);
    expect(lines.some((l) => l.includes('already enrolled as "nas-1"'))).toBe(true);
  });
});

describe("pickCandidates", () => {
  const rows = markCandidates(
    mergeCandidates(
      [
        { source: SSH_CONFIG_SOURCE, candidates: [named("attic"), named("nas"), named("vps")] },
        { source: "herdr", candidates: [named("op@attic.lan:22")] },
      ],
      (target) => (target === "attic" || target === "op@attic.lan:22" ? "op@attic.lan:22" : null),
    ),
    [{ memberId: "nas-1", sshHost: "nas", key: "nas" }],
  );
  const targets = (answer: string) => pickCandidates(rows, answer)?.map((row) => row.target) ?? null;

  test("a number picks an offered row, counting only the offered ones", () => {
    expect(targets("1")).toEqual(["attic"]);
    expect(targets(" 1 ")).toEqual(["attic"]);
    expect(targets("2")).toEqual(["vps"]);
    expect(targets("3")).toBeNull();
  });

  test("a name matches any spelling on any row, the enrolled ones included", () => {
    expect(targets("op@attic.lan:22")).toEqual(["attic"]);
    expect(targets("nas")).toEqual(["nas"]);
  });

  test("tokens split on spaces and commas, and numbers and names mix", () => {
    expect(targets("2 attic")).toEqual(["vps", "attic"]);
    expect(targets("2,1")).toEqual(["vps", "attic"]);
    expect(targets(" vps ,  1 ")).toEqual(["vps", "attic"]);
  });

  test("`all` is every offered row and leaves out the enrolled one", () => {
    expect(targets("all")).toEqual(["attic", "vps"]);
    expect(targets("vps all")).toEqual(["vps", "attic"]);
  });

  test("a row named twice, by number and by another of its names, is picked once", () => {
    expect(targets("1 attic op@attic.lan:22 1")).toEqual(["attic"]);
  });

  test("blank and an unknown name are refused rather than guessed at", () => {
    expect(targets("")).toBeNull();
    expect(targets("  , ")).toBeNull();
    expect(targets("somewhere-else")).toBeNull();
  });

  test("one unknown token refuses the whole answer, and refusedToken names it", () => {
    expect(targets("1 somewhere-else 2")).toBeNull();
    expect(targets("1 9")).toBeNull();
    expect(refusedToken(rows, "1 somewhere-else 2")).toEqual({ token: "somewhere-else", blocked: null });
    expect(refusedToken(rows, "1 9")).toEqual({ token: "9", blocked: null });
    expect(refusedToken(rows, "1 2 all")).toBeNull();
  });
});

describe("blocked rows", () => {
  const REASON = "reached without ssh (added with --via)";

  test("a row blocked by every source that named it stays blocked", () => {
    const rows = mergeCandidates(
      [
        { source: "one", candidates: [blockedNamed("vps", REASON)] },
        { source: "two", candidates: [blockedNamed("vps", "no route")] },
      ],
      () => null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.blocked).toBe(REASON);
  });

  test("an ssh config Host for the same machine clears the block", () => {
    const rows = mergeCandidates(
      [
        { source: SSH_CONFIG_SOURCE, candidates: [named("vps")] },
        { source: "core", candidates: [blockedNamed("op@vps.example:22", REASON)] },
      ],
      () => "op@vps.example:22",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.blocked).toBeNull();
    expect(rows[0]!.target).toBe("vps");
  });

  test("a later unblocked source clears the block and its spelling becomes the target", () => {
    const rows = mergeCandidates(
      [
        { source: "core", candidates: [blockedNamed("vps-via", REASON)] },
        { source: "tui", candidates: [named("op@vps.example")] },
      ],
      () => "one",
    );
    expect(rows[0]!.blocked).toBeNull();
    expect(rows[0]!.target).toBe("op@vps.example");
    expect(rows[0]!.names).toEqual(["vps-via", "op@vps.example"]);
  });

  const rows = mergeCandidates(
    [
      { source: SSH_CONFIG_SOURCE, candidates: [named("attic")] },
      { source: "core", candidates: [blockedNamed("vps", REASON), named("nas")] },
    ],
    () => null,
  );

  test("a blocked row has no number and shows the reason as its last column", () => {
    expect(renderCandidateList(rows)).toEqual([
      "Candidate hosts on this machine:",
      "",
      "   1  attic  ssh config",
      "      vps    core  cannot be added: reached without ssh (added with --via)",
      "   2  nas    core",
      "",
    ]);
    expect(offeredCandidates(rows).map((r) => r.target)).toEqual(["attic", "nas"]);
  });

  test("pick refuses a blocked row's name, and blockedReason says why", () => {
    expect(pickCandidates(rows, "vps")).toBeNull();
    expect(pickCandidates(rows, "attic vps")).toBeNull();
    expect(refusedToken(rows, "attic vps")).toEqual({ token: "vps", blocked: REASON });
    expect(pickCandidates(rows, "2")?.map((r) => r.target)).toEqual(["nas"]);
    expect(pickCandidates(rows, "all")?.map((r) => r.target)).toEqual(["attic", "nas"]);
    expect(blockedReason(rows, "vps")).toBe(REASON);
    expect(blockedReason(rows, "nas")).toBeNull();
    expect(blockedReason(rows, "nowhere")).toBeNull();
  });
});

// ── Names from another program's JSON never reach an ssh argv ────────────────

describe("hostRefusal: one refusal per kind of name", () => {
  const refused: [what: string, target: string][] = [
    ["a leading dash (an ssh option)", "-oProxyCommand=evil"],
    ["a leading dash after a user", "op@-oProxyCommand=evil"],
    ["a dashed user", "-op@attic"],
    ["a space", "attic lan"],
    ["a tab", "attic\tlan"],
    ["a newline", "attic\nlan"],
    ["a no-break space", "attic\u00a0lan"],
    ["a semicolon", "attic;reboot"],
    ["an ampersand", "attic&reboot"],
    ["a pipe", "attic|cat"],
    ["a dollar", "$(reboot)"],
    ["a backtick", "`reboot`"],
    ["an angle bracket", "attic>file"],
    ["a quote", "att'ic"],
    ["a double quote", 'att"ic'],
    ["a backslash", "att\\ic"],
    ["a glob", "att*"],
    ["a tilde", "~attic"],
    ["an escape sequence", "attic\u001b[2J"],
    ["a NUL", "attic\u0000"],
    ["a DEL", "attic\u007f"],
    ["a C1 control", "attic\u009b"],
    ["an empty value", ""],
    ["a user with no host", "op@"],
  ];
  for (const [what, target] of refused) {
    test(`refuses ${what}`, () => {
      expect(hostRefusal(target)).not.toBeNull();
    });
  }

  test("takes every spelling a real list uses", () => {
    for (const ok of ["attic", "op@attic.lan", "op@attic.lan:2222", "fd00::1", "op@[fd00::1]:2222", "a_b-c.d", "fe80::1%eth0"]) {
      expect(hostRefusal(ok)).toBeNull();
    }
  });
});

describe("screenCandidates", () => {
  test("a refused target is dropped, named once, and the rest of the list stays", () => {
    const warned: string[] = [];
    const kept = screenCandidates(
      "Herdr machine name",
      [named("-oProxyCommand=evil"), named("op@attic"), named("two words")],
      (line) => warned.push(line),
    );
    expect(kept.map((c) => c.target)).toEqual(["op@attic"]);
    expect(warned).toEqual([
      'refused: Herdr machine name "-oProxyCommand=evil" is not a valid host',
      'refused: Herdr machine name "two words" is not a valid host',
    ]);
  });

  test("a control character is shown as an escape, never sent to the terminal as a byte", () => {
    const warned: string[] = [];
    screenCandidates("Herdr machine name", [named("attic\u001b[2J")], (line) => warned.push(line));
    expect(warned).toEqual(['refused: Herdr machine name "attic\\x1b[2J" is not a valid host']);
    expect(warned.join("")).not.toContain("\u001b");
  });

  test("a label with a control character refuses its row; an ordinary label with a space does not", () => {
    const warned: string[] = [];
    const kept = screenCandidates(
      "Herdr machine name",
      [
        { target: "op@a", label: "my laptop", id: null, blocked: null },
        { target: "op@b", label: "evil\u001b[2J", id: null, blocked: null },
      ],
      (line) => warned.push(line),
    );
    expect(kept.map((c) => c.target)).toEqual(["op@a"]);
    expect(warned).toEqual(['refused: Herdr machine name "evil\\x1b[2J" is not a valid host']);
  });

  test("a blocked row's target is a command and may hold spaces, but never a control character", () => {
    const warned: string[] = [];
    const kept = screenCandidates(
      "Herdr machine name",
      [blockedNamed("fly ssh console -a x", "via"), blockedNamed("fly\u001b[2J", "via")],
      (line) => warned.push(line),
    );
    expect(kept.map((c) => c.target)).toEqual(["fly ssh console -a x"]);
    expect(warned).toHaveLength(1);
  });
});
