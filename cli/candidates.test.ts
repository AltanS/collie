import { describe, expect, test } from "bun:test";

import { CANDIDATE_TIMEOUT_MS, type HostCandidate, type HostProbe } from "../bridge/mux/host-candidates.ts";
import {
  markCandidates,
  mergeCandidates,
  offeredCandidates,
  parseResolvedSshTarget,
  pickCandidate,
  renderCandidateList,
  resolvedSshTarget,
  splitSshTarget,
  sshResolveArgs,
  SSH_CONFIG_SOURCE,
  type SourcedCandidates,
} from "./candidates.ts";

// The merge, the mark and the rendering, over a probe that records rather than spawns. **NOTHING
// here runs `ssh`.**

const named = (target: string): HostCandidate => ({ target, label: null, id: null });

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
    expect(sshResolveArgs("attic")).toEqual(["-G", "attic"]);
    expect(sshResolveArgs("op@attic.lan:2222")).toEqual(["-G", "-p", "2222", "op@attic.lan"]);
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
    const { probe, spawns } = probeFor({ "ssh -G attic": resolved("op", "attic.lan", "22") });
    expect(resolvedSshTarget("attic", probe)).toBe("op@attic.lan:22");
    expect(spawns).toEqual(["ssh -G attic"]);
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
        { source: "herdr", candidates: [{ target: "op@attic.lan:22", label: "The attic", id: "m-1" }] },
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

describe("pickCandidate", () => {
  const rows = markCandidates(
    mergeCandidates(
      [
        { source: SSH_CONFIG_SOURCE, candidates: [named("attic"), named("nas")] },
        { source: "herdr", candidates: [named("op@attic.lan:22")] },
      ],
      (target) => (target === "attic" || target === "op@attic.lan:22" ? "op@attic.lan:22" : null),
    ),
    [{ memberId: "nas-1", sshHost: "nas", key: "nas" }],
  );

  test("a number picks an offered row, counting only the offered ones", () => {
    expect(pickCandidate(rows, "1")).toBe("attic");
    expect(pickCandidate(rows, " 1 ")).toBe("attic");
    expect(pickCandidate(rows, "2")).toBeNull();
  });

  test("a name matches any spelling on any row, the enrolled ones included", () => {
    expect(pickCandidate(rows, "op@attic.lan:22")).toBe("attic");
    expect(pickCandidate(rows, "nas")).toBe("nas");
  });

  test("blank and an unknown name are refused rather than guessed at", () => {
    expect(pickCandidate(rows, "")).toBeNull();
    expect(pickCandidate(rows, "somewhere-else")).toBeNull();
  });
});
