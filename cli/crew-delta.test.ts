import { describe, expect, test } from "bun:test";

import { leadStore, member, peerStore, T0 } from "../bridge/crew/fixtures.ts";
import { serializeTrustStore, TrustStore, type TrustStoreData } from "../bridge/crew/trust-store.ts";
import { hostFor } from "../bridge/host.ts";
import { sshResolveArgs } from "./candidates.ts";
import { crewDelta, deltaLines } from "./crew-delta.ts";
import { fakeExec, fakeOps, type SeededOps } from "./fakes.ts";

// The delta against fakes for every seam: a scripted `Exec`, an in-memory trust store and an
// in-memory ops store. Nothing here spawns a process. The multiplexers' machine lists are asked
// through their real providers, so the commands below are the ones those providers run.

const CORE_LIST = "hc machine ls --json";
const TUI_LIST = "herdr machine list --json";

interface Options {
  /** `hc machine ls --json`'s stdout. Absent: there is no `hc` binary. */
  readonly core?: string;
  /** `herdr machine list --json`'s stdout. Absent: there is no `herdr` binary. */
  readonly tui?: string;
  /** `hc` is installed but answers with a failure. */
  readonly coreBroken?: true;
  readonly store?: TrustStoreData | null;
  readonly ops?: SeededOps;
  /** `ssh -G <target>` output per target. Absent: there is no `ssh`. */
  readonly resolve?: Readonly<Record<string, string>>;
  readonly platform?: "linux" | "win32";
}

function setup(opts: Options = {}) {
  const initial = opts.store === undefined ? leadStore() : opts.store;
  let contents = initial === null ? null : serializeTrustStore(initial);
  const store = new TrustStore("/state", {
    read: async () => contents,
    write: async (_p, d) => {
      contents = d;
    },
  });
  const answers: [string, { stdout?: string; stderr?: string; code?: number }][] = [];
  if (opts.core !== undefined) answers.push([CORE_LIST, { stdout: opts.core }]);
  if (opts.coreBroken === true) answers.push([CORE_LIST, { code: 1, stdout: "", stderr: "boom" }]);
  if (opts.tui !== undefined) answers.push([TUI_LIST, { stdout: opts.tui }]);
  for (const [target, stdout] of Object.entries(opts.resolve ?? {})) {
    answers.push([`ssh ${sshResolveArgs(target).join(" ")}`, { stdout }]);
  }
  const exec = fakeExec({
    absent: [
      ...(opts.core === undefined && opts.coreBroken !== true ? ["hc"] : []),
      ...(opts.tui === undefined ? ["herdr"] : []),
      ...(opts.resolve === undefined ? ["ssh"] : []),
    ],
    answers,
  });
  const ops = fakeOps(opts.ops);
  const deps = { exec, store, ops, host: hostFor(opts.platform ?? "linux") };
  return { exec, deps, ops };
}

const machines = (...entries: readonly Record<string, string | boolean>[]): string => JSON.stringify({ machines: entries });
const record = (sshHost: string, source: string | null) => ({ sshHost, path: "/opt/collie", port: 8787, recordedAt: T0, source });
const crewOf = (...ids: readonly string[]): TrustStoreData => leadStore({ peers: ids.map((memberId) => member({ memberId })) });

describe("crewDelta: the machines a multiplexer knows that this crew does not have", () => {
  test("names the machines of a source that no member covers, by the list's own name", async () => {
    const { deps } = setup({
      core: machines({ target: "altan@minibuch", name: "minibuch" }, { target: "vps" }, { target: "nas", name: "nas" }),
      store: crewOf("nas"),
      ops: { nas: record("nas", "herdr-core") },
    });
    const delta = await crewDelta(deps);
    expect(delta.missing).toEqual([{ source: "herdr-core", targets: ["minibuch", "vps"] }]);
    expect(delta.forgotten).toEqual([]);
    expect(deltaLines(delta)).toEqual([
      "herdr-core knows 2 machines that are not in this crew: minibuch, vps. Add them with `collie crew add`.",
    ]);
  });

  test("one machine reads in the singular", async () => {
    const { deps } = setup({ core: machines({ target: "vps" }) });
    expect(deltaLines(await crewDelta(deps))).toEqual([
      "herdr-core knows 1 machine that is not in this crew: vps. Add it with `collie crew add`.",
    ]);
  });

  test("each source gets its own line, in registry order", async () => {
    const { deps } = setup({ core: machines({ target: "vps" }), tui: JSON.stringify([{ target: "attic" }]) });
    const delta = await crewDelta(deps);
    expect(delta.missing.map((m) => m.source).toSorted()).toEqual(["herdr", "herdr-core"]);
    expect(deltaLines(delta)).toHaveLength(2);
  });

  test("a blocked machine and a sandbox are not missing", async () => {
    const { deps } = setup({
      core: machines({ target: "vps", via: true }, { target: "scratch", temporary: true }, { target: "minibuch" }),
    });
    expect((await crewDelta(deps)).missing).toEqual([{ source: "herdr-core", targets: ["minibuch"] }]);
  });

  test("a machine the crew already has, under another spelling, is not missing", async () => {
    const { deps } = setup({
      core: machines({ target: "op@attic.lan:22", name: "attic" }),
      store: crewOf("attic"),
      ops: { attic: record("attic-alias", null) },
      resolve: {
        "op@attic.lan:22": "user op\nhostname attic.lan\nport 22\n",
        "attic-alias": "user op\nhostname attic.lan\nport 22\n",
      },
    });
    const delta = await crewDelta(deps);
    expect(delta.missing).toEqual([]);
    expect(deltaLines(delta)).toEqual([]);
  });

  test("a solo collie is told too: it has no members to cover anything", async () => {
    const { deps } = setup({ core: machines({ target: "vps" }), store: null });
    expect((await crewDelta(deps)).missing).toEqual([{ source: "herdr-core", targets: ["vps"] }]);
  });
});

describe("crewDelta: a member with no crew add record is still in the crew", () => {
  // The lab case (M84 test 2, BUG 1): `member` joined by hand, so the trust store pins it and the ops
  // store has no record. The core lists it as `member`, at `op@192.168.77.2`.
  const handJoined = (memberId: string, address: string): TrustStoreData =>
    leadStore({ peers: [member({ memberId, address })] });

  test("is matched on the host of its trust-store address, resolved through ssh -G", async () => {
    const { deps } = setup({
      core: machines({ target: "op@lab-two", name: "two" }, { target: "vps" }),
      store: handJoined("box", "192.168.77.2:8787"),
      ops: { other: record("elsewhere", null) },
      resolve: {
        "op@lab-two": "user op\nhostname 192.168.77.2\nport 22\n",
        vps: "user op\nhostname vps.example\nport 22\n",
      },
    });
    expect((await crewDelta(deps)).missing).toEqual([{ source: "herdr-core", targets: ["vps"] }]);
  });

  test("is matched on the host part of the row's own target when nothing resolves", async () => {
    const { deps } = setup({
      core: machines({ target: "op@192.168.77.2", name: "two" }),
      store: handJoined("box", "192.168.77.2:8787"),
    });
    expect(await crewDelta(deps)).toEqual({ missing: [], forgotten: [] });
  });

  test("an IPv6 address keeps its brackets out of the match", async () => {
    const { deps } = setup({
      core: machines({ target: "op@[fd00::2]:22" }),
      store: handJoined("box", "[fd00::2]:8787"),
    });
    expect((await crewDelta(deps)).missing).toEqual([]);
  });

  test("is matched on its member id, case-insensitively, against the row's name and target host", async () => {
    const { deps } = setup({
      core: machines({ target: "op@192.168.77.9", name: "Member" }, { target: "op@Attic" }),
      store: leadStore({
        peers: [
          member({ memberId: "member", address: "10.9.9.1:8787" }),
          member({ memberId: "attic", address: "10.9.9.2:8787" }),
        ],
      }),
    });
    expect((await crewDelta(deps)).missing).toEqual([]);
  });

  test("with no crew-ops.json at all, the trust store alone still covers the machine", async () => {
    const { deps, ops } = setup({
      core: machines({ target: "op@192.168.77.2", name: "member" }),
      store: handJoined("member", "192.168.77.2:8787"),
    });
    expect(ops.contents()).toBeNull();
    expect(deltaLines(await crewDelta(deps))).toEqual([]);
  });

  test("a peer that matches nothing leaves the row missing", async () => {
    const { deps } = setup({
      core: machines({ target: "op@192.168.77.3", name: "omarchy" }),
      store: handJoined("member", "192.168.77.2:8787"),
      resolve: { "op@192.168.77.3": "user op\nhostname 192.168.77.3\nport 22\n" },
    });
    expect((await crewDelta(deps)).missing).toEqual([{ source: "herdr-core", targets: ["omarchy"] }]);
  });

  test("is never reported as forgotten: it has no recorded source", async () => {
    const { deps } = setup({ core: machines({ target: "vps" }), store: handJoined("member", "192.168.77.2:8787") });
    expect((await crewDelta(deps)).forgotten).toEqual([]);
  });

  test("its address costs no ssh -G: only the listed targets are resolved", async () => {
    const { deps, exec } = setup({
      core: machines({ target: "vps" }),
      store: handJoined("member", "192.168.77.2:8787"),
      resolve: { vps: "user u\nhostname vps\nport 22\n" },
    });
    await crewDelta(deps);
    expect(exec.calls.filter((c) => c.startsWith("ssh "))).toEqual(["ssh -G vps"]);
  });
});

describe("crewDelta: a member its source no longer lists", () => {
  test("is reported when the source answered with machines and none is the member", async () => {
    const { deps } = setup({
      core: machines({ target: "vps" }),
      store: crewOf("oldbox"),
      ops: { oldbox: record("oldbox", "herdr-core") },
    });
    const delta = await crewDelta(deps);
    expect(delta.forgotten).toEqual([{ memberId: "oldbox", source: "herdr-core" }]);
    expect(deltaLines(delta)).toContain(
      "oldbox is in this crew, but herdr-core no longer lists it. Keep it, or drop it with `collie crew remove oldbox`.",
    );
  });

  test("is not reported when the source still lists it", async () => {
    const { deps } = setup({
      core: machines({ target: "oldbox" }, { target: "vps" }),
      store: crewOf("oldbox"),
      ops: { oldbox: record("oldbox", "herdr-core") },
    });
    expect((await crewDelta(deps)).forgotten).toEqual([]);
  });

  test("a member with no recorded source is never reported", async () => {
    const { deps } = setup({
      core: machines({ target: "vps" }),
      store: crewOf("typed", "legacy"),
      ops: { typed: record("typed", null), legacy: { sshHost: "legacy", path: "/opt/collie", port: 8787, recordedAt: T0 } },
    });
    expect((await crewDelta(deps)).forgotten).toEqual([]);
  });

  test("a source that is absent reports nothing in either direction", async () => {
    const { deps } = setup({ store: crewOf("oldbox"), ops: { oldbox: record("oldbox", "herdr-core") } });
    expect(await crewDelta(deps)).toEqual({ missing: [], forgotten: [] });
  });

  test("an UNHEALTHY source reports nothing in either direction", async () => {
    const { deps } = setup({
      coreBroken: true,
      store: crewOf("oldbox"),
      ops: { oldbox: record("oldbox", "herdr-core") },
    });
    expect(await crewDelta(deps)).toEqual({ missing: [], forgotten: [] });
  });

  test("a source that answered with no machines at all is not evidence", async () => {
    const { deps } = setup({
      core: machines(),
      store: crewOf("oldbox"),
      ops: { oldbox: record("oldbox", "herdr-core") },
    });
    expect(await crewDelta(deps)).toEqual({ missing: [], forgotten: [] });
  });

  test("a member is judged by the source that suggested it, not by another one", async () => {
    const { deps } = setup({
      core: machines({ target: "oldbox" }),
      tui: JSON.stringify([{ target: "vps" }]),
      store: crewOf("oldbox"),
      ops: { oldbox: record("oldbox", "herdr") },
    });
    expect((await crewDelta(deps)).forgotten).toEqual([{ memberId: "oldbox", source: "herdr" }]);
  });
});

describe("crewDelta: read-only, and silent where it has nothing to compare", () => {
  test("a peer gets the empty delta and spawns nothing", async () => {
    const { deps, exec } = setup({ core: machines({ target: "vps" }), store: peerStore() });
    expect(await crewDelta(deps)).toEqual({ missing: [], forgotten: [] });
    expect(exec.calls).toEqual([]);
  });

  test("a Windows host gets the empty delta and spawns nothing", async () => {
    const { deps, exec } = setup({ core: machines({ target: "vps" }), platform: "win32" });
    expect(await crewDelta(deps)).toEqual({ missing: [], forgotten: [] });
    expect(exec.calls).toEqual([]);
  });

  test("a lead with no machine list at all produces no line", async () => {
    const { deps } = setup({ store: crewOf("nas"), ops: { nas: record("nas", null) } });
    expect(deltaLines(await crewDelta(deps))).toEqual([]);
  });

  test("spawns only the machine lists and `ssh -G`, each target once, each under the picker's budget", async () => {
    const { deps, exec } = setup({
      core: machines({ target: "vps" }),
      tui: JSON.stringify([{ target: "vps" }]),
      store: crewOf("nas"),
      ops: { nas: record("nas", "herdr-core") },
      resolve: { vps: "user u\nhostname vps\nport 22\n", nas: "user u\nhostname nas\nport 22\n" },
    });
    await crewDelta(deps);
    expect(exec.calls.filter((c) => c.startsWith("ssh ")).toSorted()).toEqual(["ssh -G nas", "ssh -G vps"]);
    expect(exec.calls.every((c) => c === CORE_LIST || c === TUI_LIST || c.startsWith("ssh -G "))).toBe(true);
    expect(exec.timeouts.every((t) => t.ms === 3000)).toBe(true);
  });

  test("a broken source's warning is dropped: the delta prints lines about the crew, not about tools", async () => {
    const { deps } = setup({ coreBroken: true });
    expect(deltaLines(await crewDelta(deps))).toEqual([]);
  });
});

describe("deltaLines", () => {
  test("is empty for the empty delta", () => {
    expect(deltaLines({ missing: [], forgotten: [] })).toEqual([]);
  });
});
