import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "../bridge/audit.ts";
import {
  createTrustStore,
  PACK_PROTOCOL_VERSION,
  selfIdentity,
  type EnrollResponse,
} from "../bridge/pack/enrollment.ts";
import { fp, leadStore, material, member, PACK, peerStore, T0 } from "../bridge/pack/fixtures.ts";
import {
  serializeTrustStore,
  TrustStore,
  type TrustStoreData,
  type TrustStoreIo,
} from "../bridge/pack/trust-store.ts";
import { capture, context, fakeExec, fakeFiles } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  cmdJoin,
  cmdLeave,
  cmdPack,
  cmdPackInvite,
  cmdPackRemove,
  cmdPackRotate,
  cmdPackStatus,
  cmdPromote,
  cmdReconnect,
  enrollUrl,
  parsePackArgs,
  readToken,
  type PackDeps,
} from "./pack.ts";

// The pack verbs, against fakes for every seam. NOTHING here reaches a service manager, a tailnet, a
// real trust store or a network: `restart`/`serve`/`unserve` are counters, the transport is a
// function, and the store is an in-memory `TrustStoreIo`. That is the same safety boundary
// cli/fakes.ts draws for the lifecycle verbs, extended one milestone.

const TAILSCALE_JSON = JSON.stringify({ Self: { DNSName: "laptop.tail.ts.net." } });

interface Harness {
  deps: PackDeps;
  io: ReturnType<typeof capture>;
  exec: ReturnType<typeof fakeExec>;
  files: ReturnType<typeof fakeFiles>;
  audit: AuditEntry[];
  /** Every request the verbs made: method, URL, headers and body. */
  requests: { url: string; method: string; headers: Record<string, string>; body: string }[];
  data(): TrustStoreData | null;
  restarts: number[];
  serves: number[];
  unserves: number[];
  cleared: string[][];
}

type Reply = Response | Error;

/**
 * Build a harness. `initial` is the store on disk (`null` = never enrolled); `replies` answers each
 * request in order, and an `Error` is a transport throw — the shape a peer that is simply not there
 * produces.
 */
function harness(initial: TrustStoreData | null, replies: Reply[] = [], over: Partial<PackDeps> = {}): Harness {
  let contents = initial === null ? null : serializeTrustStore(initial);
  const io: TrustStoreIo = {
    read: async () => contents,
    write: async (_p, d) => {
      contents = d;
    },
  };
  const store = new TrustStore("/state", io);
  const auditLines: AuditEntry[] = [];
  const out = capture();
  const exec = fakeExec({ answers: [["tailscale status --json", { stdout: TAILSCALE_JSON }]] });
  const files = fakeFiles({ "/home/pat/.config/herdr/herdr.sock": "" });
  const requests: Harness["requests"] = [];
  const restarts: number[] = [];
  const serves: number[] = [];
  const unserves: number[] = [];
  const cleared: string[][] = [];
  let n = 0;

  const deps: PackDeps = {
    // `clientFor` races the fake fetch (which resolves as soon as the event loop turns) against a
    // REAL `setTimeout` sized from this env var (`packTimeoutBudget`, default ~1200ms here). Nothing
    // in this suite exercises that budget — every "unreachable" case throws synchronously instead —
    // so the only thing the default timeout can do here is misfire under a stalled event loop and
    // report a reachable fake peer as unreachable. Set it far above anything this process could stall
    // for real, so the timer never fires; it does not change what any test observes.
    ctx: context({ COLLIE_PACK_TIMEOUT_MS: "60000" }, { socket: "/home/pat/.config/herdr/herdr.sock" }),
    io: out,
    exec,
    files,
    store,
    audit: new AuditLog((l) => void auditLines.push(JSON.parse(l) as AuditEntry), () => T0),
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      requests.push({
        url,
        method: init.method ?? "GET",
        headers,
        body: typeof init.body === "string" ? init.body : "",
      });
      const reply = replies[n++];
      if (reply === undefined) return jsonReply({});
      if (reply instanceof Error) throw reply;
      return reply;
    },
    now: () => T0,
    random: (() => {
      let i = 0;
      return () => `r${++i}`;
    })(),
    mintIdentity: () => Promise.resolve(material("fresh")),
    // The operator now pastes `<token>.<lead-fingerprint>` (§8.2). The suffix is the lead's own cert
    // fingerprint — `fp("desk")`, matching the lead in `ENROLLED` — so a `join` split yields the wire
    // token "token-from-stdin" and an invited fingerprint the answer will match.
    readStdin: () => Promise.resolve(`token-from-stdin.${fp("desk")}\n`),
    restart: () => {
      restarts.push(requests.length);
      return Promise.resolve(EXIT.OK);
    },
    serve: () => {
      serves.push(requests.length);
      return Promise.resolve(EXIT.OK);
    },
    unserve: () => {
      unserves.push(requests.length);
      return EXIT.OK;
    },
    clearNotifications: (tags) => {
      cleared.push([...tags]);
      return Promise.resolve();
    },
    ...over,
  };

  return {
    deps,
    io: out,
    exec,
    files,
    audit: auditLines,
    requests,
    data: () => store.current(),
    restarts,
    serves,
    unserves,
    cleared,
  };
}

/** A pack response: 200, with the two headers §6 requires so `PeerClient` accepts it. */
function jsonReply(body: unknown, status = 200, memberId = "peer"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-pack-protocol": String(PACK_PROTOCOL_VERSION),
      "x-pack-member": memberId,
    },
  });
}

/** The lead's enrollment answer — the §8.2 transfer table, as `join` will parse it. */
const ENROLLED: EnrollResponse = {
  protocol: 1,
  packId: PACK.packId,
  packName: PACK.name,
  packSecret: PACK.secret,
  secretGeneration: 1,
  memberId: "laptop",
  leadMemberId: "desk",
  leadFingerprint: fp("desk"),
  leadCertPem: material("desk").certPem,
};

const text = (io: ReturnType<typeof capture>): string => [...io.stdout, ...io.stderr].join("\n");

// ── Argument handling ────────────────────────────────────────────────────────

describe("parsePackArgs", () => {
  test("splits positionals, `--flag value`, `--flag=value` and bare flags", () => {
    const parsed = parsePackArgs(["desk.ts.net", "-", "--label", "laptop", "--address=nas:1", "--force"]);
    expect(parsed.positional).toEqual(["desk.ts.net", "-"]);
    expect(parsed.flags).toEqual({ label: "laptop", address: "nas:1" });
    expect(parsed.bare.has("force")).toBe(true);
  });

  test("a value-taking flag with nothing after it is empty, not the next flag", () => {
    expect(parsePackArgs(["--label", "--force"]).flags).toEqual({ label: "" });
  });
});

describe("readToken — §8.3, and the warning that makes it real", () => {
  test("`-` reads stdin and says nothing", async () => {
    const h = harness(null);
    // `readToken` is a passthrough: it returns the whole operator string, fingerprint suffix and all —
    // `join` is what splits `<token>.<lead-fingerprint>`, not this.
    expect(await readToken("-", h.deps)).toBe(`token-from-stdin.${fp("desk")}`);
    expect(h.io.stderr).toEqual([]);
  });

  test("`@file` reads a file and says nothing", async () => {
    const h = harness(null);
    h.files.write("/run/token", "  filed-token\n");
    expect(await readToken("@/run/token", h.deps)).toBe("filed-token");
    expect(h.io.stderr).toEqual([]);
  });

  test("a literal token WARNS, naming the exact exposure ADR 0001 records", async () => {
    const h = harness(null);
    expect(await readToken("literal-token", h.deps)).toBe("literal-token");
    expect(text(h.io)).toContain("/proc/<pid>/cmdline");
    expect(text(h.io)).toContain("Prefer `-` (stdin) or `@<file>`");
  });

  test("an unreadable token file is an error, not an empty token", async () => {
    const h = harness(null);
    expect(await readToken("@/nope", h.deps)).toBeNull();
  });
});

describe("enrollUrl", () => {
  test("a bare host becomes an https enrollment URL", () => {
    expect(enrollUrl("desk.ts.net")).toBe("https://desk.ts.net/pack/v1/enroll");
    expect(enrollUrl("http://desk:8787")).toBe("http://desk:8787/pack/v1/enroll");
  });

  test("an address carrying a path, a query or credentials is refused", () => {
    for (const bad of ["desk.ts.net/api", "desk.ts.net?x=1", "user:pw@desk.ts.net", "", "::::"]) {
      expect(enrollUrl(bad)).toBeNull();
    }
  });
});

// ── pack invite ──────────────────────────────────────────────────────────────

describe("collie pack invite", () => {
  test("mints a token, prints `<token>.<lead-fingerprint>` once, and stores only the token's hash", async () => {
    const h = harness(leadStore());
    expect(await cmdPackInvite(h.deps, [])).toBe(EXIT.OK);
    const printed = h.io.stdout[0]!;
    // The operator carries the wire token AND this lead's own certificate fingerprint (§8.2), so `join`
    // can authenticate the lead back. `fp("desk")` is `leadStore`'s `self.fingerprint`.
    expect(printed).toBe(`r1.${fp("desk")}`);
    // The wire token — the part the lead ever hashes — is only "r1", and it is never stored in the
    // clear. Scoped to `invites` (not the whole store): `self` carries a real certificate whose base64
    // can coincidentally contain a short deterministic token like "r1" as a substring.
    expect(JSON.stringify(h.data()!.invites)).not.toContain("r1");
    expect(text(h.io)).toContain("single-use");
    expect(text(h.io)).toContain("expires");
  });

  test("the printed instruction is the stdin form, not the argv one", async () => {
    const h = harness(leadStore());
    await cmdPackInvite(h.deps, []);
    expect(text(h.io)).toContain("collie join laptop.tail.ts.net -");
    expect(text(h.io)).toContain("leaves it in `ps` output");
  });

  test("it materialises the store — and identity minting refusing is the whole verb failing", async () => {
    const ok = harness(null);
    expect(await cmdPackInvite(ok.deps, [])).toBe(EXIT.OK);
    expect(ok.data()!.pack).not.toBeNull();

    const refused = harness(null, [], {
      mintIdentity: () => Promise.reject(new Error("certificate minting is not wired yet")),
    });
    expect(await cmdPackInvite(refused.deps, [])).toBe(EXIT.FAIL);
    expect(refused.data()).toBeNull();
    expect(text(refused.io)).toContain("certificate minting is not wired");
  });

  test("a peer refuses: invites are minted on the lead", async () => {
    const h = harness(peerStore());
    expect(await cmdPackInvite(h.deps, [])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("invites are minted on the lead");
  });

  test("the bridge is restarted so it can answer the invite it just minted", async () => {
    const h = harness(leadStore());
    await cmdPackInvite(h.deps, []);
    expect(h.restarts).toHaveLength(1);
  });
});

// ── join ─────────────────────────────────────────────────────────────────────

describe("collie join", () => {
  const joinArgs = ["desk.ts.net", "-"];

  test("enrolls, pins the lead, and never puts a credential in argv or a URL", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.OK);
    const req = h.requests[0]!;
    expect(req.url).toBe("https://desk.ts.net/pack/v1/enroll");
    expect(req.method).toBe("POST");
    expect(req.url).not.toContain("token-from-stdin");
    expect(JSON.parse(req.body)).toEqual({
      protocol: 1,
      token: "token-from-stdin",
      fingerprint: fp("fresh"),
      certPem: material("fresh").certPem,
      address: "laptop.tail.ts.net",
      label: null,
    });
    // Nothing was handed to a subprocess: the token cannot appear in anyone's `ps`.
    expect(h.exec.calls.join("\n")).not.toContain("token-from-stdin");

    const data = h.data()!;
    expect(data.pack).toMatchObject({ packId: PACK.packId, secret: PACK.secret });
    expect(data.lead).toMatchObject({ memberId: "desk", fingerprint: fp("desk"), address: "desk.ts.net" });
    expect(data.self.memberId).toBe("laptop");
    expect(h.audit.map((l) => l.action)).toContain("pack.joined");
  });

  test("names the LEAD's restart as the last step — nothing else can tell the operator", async () => {
    // The enrollment landed in the lead's RUNNING process, which read its roster at boot. This side
    // restarts itself; the lead cannot be restarted from here, so it is said out loud.
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.OK);
    const rendered = text(h.io);
    expect(rendered).toContain("ONE STEP LEFT, on the lead (desk): `collie restart` there.");
    expect(rendered).toContain("read that roster at");
    // This machine still restarts itself — the reminder is in addition, not instead.
    expect(h.restarts).toHaveLength(1);
  });

  test("joining a pack you are already in is its OWN exit code and says what to run", async () => {
    const h = harness(peerStore());
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("already in pack");
    expect(text(h.io)).toContain("collie leave");
    expect(h.requests).toEqual([]);
  });

  test("a spent or expired token is REFUSED — a distinct code and the recovery step", async () => {
    const h = harness(null, [new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })]);
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.REFUSED);
    expect(text(h.io)).toContain("spent, expired");
    expect(text(h.io)).toContain("collie pack invite");
    expect(h.data()!.pack).toBeNull();
  });

  test("an address that does not answer is UNREACHABLE, and reachability is named as the operator's", async () => {
    const h = harness(null, [new Error("connect ECONNREFUSED")]);
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.UNREACHABLE);
    expect(text(h.io)).toContain("could not reach desk.ts.net");
    expect(h.data()!.pack).toBeNull();
  });

  test("a version-skewed lead is refused, naming the fix", async () => {
    const h = harness(null, [new Response("{}", { status: 409 })]);
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.REFUSED);
    expect(text(h.io)).toContain("protocol mismatch");
  });

  test("the herd notifications are cleared BEFORE the restart that mutes the herd path", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    h.files.write("/home/pat/.config/herdr/sessions/work/herdr.sock", "");
    await cmdJoin(h.deps, joinArgs);
    // Both this machine's slots — the primary's bare tag and the named session's.
    expect(h.cleared).toEqual([["collie:herd", "collie:herd:work"]]);
    expect(h.restarts).toHaveLength(1);
  });

  test("a peer publishes nothing: the front door is torn down AFTER the restart that re-publishes it", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    await cmdJoin(h.deps, joinArgs);
    expect(h.restarts).toHaveLength(1);
    expect(h.unserves).toHaveLength(1);
    expect(text(h.io)).toContain("publishes no front door");
  });

  test("without an address the lead can dial, it refuses rather than inventing localhost", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")], {
      exec: fakeExec({ absent: ["tailscale"] }),
    });
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("--address");
    expect(h.requests).toEqual([]);
  });

  test("missing arguments are a usage error, not an attempt", async () => {
    const h = harness(null);
    expect(await cmdJoin(h.deps, ["desk.ts.net"])).toBe(EXIT.USAGE);
    expect(h.requests).toEqual([]);
  });

  // ── The lead's fingerprint on the invite authenticates the lead to the joiner (F1) ──
  // The operator carries `<token>.<lead-fingerprint>`. `join` sends ONLY the token on the wire and
  // requires the lead's answer to present the fingerprinted certificate — closing the MITM/relay a
  // self-consistent enrollment response could not.

  test("the wire EnrollRequest.token is still just T — the fingerprint never leaves this machine", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.OK);
    const wireToken = JSON.parse(h.requests[0]!.body).token as string;
    expect(wireToken).toBe("token-from-stdin");
    // The invited fingerprint rode alongside the token in the operator's paste, not on the wire.
    expect(wireToken).not.toContain(".");
    expect(h.requests[0]!.body).not.toContain(fp("desk"));
  });

  test("a lead whose certificate does not match the invite fingerprint is REFUSED, nothing persisted", async () => {
    // A solo store already on disk: `ensureStore` returns it untouched, so an "untouched" assertion is
    // a clean deep-equal rather than a claim about a freshly-materialised identity.
    const solo = createTrustStore(selfIdentity("laptop", material("laptop"), T0));
    // The invite names `fp("nas")`, but the answer (`ENROLLED`) presents `desk`'s certificate — a relay
    // answering with its own identity. The token was well-formed, so the refusal is the pin check.
    const h = harness(solo, [jsonReply(ENROLLED, 200, "desk")], {
      readStdin: () => Promise.resolve(`token-from-stdin.${fp("nas")}`),
    });
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.REFUSED);
    expect(text(h.io)).toContain("does not match the invite");
    expect(text(h.io)).toContain("man-in-the-middle");
    // The request WAS made (the answer had to arrive to be judged) — but nothing was pinned.
    expect(h.requests).toHaveLength(1);
    expect(h.data()).toEqual(solo);
    expect(h.audit.map((l) => l.action)).not.toContain("pack.joined");
  });

  test("a matching fingerprint enrolls and pins — the check passes the honest lead through", async () => {
    // `joinArgs` + the default stdin carry `fp("desk")`, which is exactly `ENROLLED`'s lead.
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.OK);
    expect(h.data()!.lead).toMatchObject({ memberId: "desk", fingerprint: fp("desk") });
    expect(h.audit.map((l) => l.action)).toContain("pack.joined");
  });

  test("an old-format token with no `.` FAILS CLOSED — refused before any dial", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")], {
      readStdin: () => Promise.resolve("token-with-no-fingerprint"),
    });
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.REFUSED);
    expect(text(h.io)).toContain("no lead fingerprint");
    // Fail-closed happens before the network: nothing was dialled, nothing was persisted.
    expect(h.requests).toEqual([]);
    expect(h.data()).toBeNull();
  });

  test("a malformed (non-64-hex) fingerprint part is refused — a truncated paste does not enroll", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")], {
      readStdin: () => Promise.resolve("token-from-stdin.not-a-real-fingerprint"),
    });
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.REFUSED);
    expect(text(h.io)).toContain("malformed");
    expect(h.requests).toEqual([]);
    // Refused before `ensureStore`, so no identity was even materialised — the store is still absent.
    expect(h.data()).toBeNull();
  });
});

// ── leave ────────────────────────────────────────────────────────────────────

describe("collie leave", () => {
  test("revokes on both sides when the lead answers", async () => {
    const h = harness(peerStore(), [jsonReply({ removed: "laptop" }, 200, "desk")]);
    expect(await cmdLeave(h.deps)).toBe(EXIT.OK);
    expect(h.requests[0]!.url).toBe("https://desk.example:8787/pack/v1/leave");
    expect(h.requests[0]!.headers.authorization).toBe(`Bearer ${PACK.secret}`);
    expect(text(h.io)).toContain("The lead removed this machine");
    const data = h.data()!;
    expect(data.pack).toBeNull();
    expect(data.lead).toBeNull();
    expect(serializeTrustStore(data)).not.toContain(PACK.secret);
  });

  test("with the lead down it still stops trusting it here, and SAYS the lead still lists us", async () => {
    const h = harness(peerStore(), [new Error("no route to host")]);
    expect(await cmdLeave(h.deps)).toBe(EXIT.OK);
    expect(h.data()!.pack).toBeNull();
    expect(text(h.io)).toContain("still lists this machine");
    expect(text(h.io)).toContain("collie pack remove laptop");
  });

  test("a lead refuses to leave — that would strand its peers", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdLeave(h.deps)).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("collie pack remove");
    expect(text(h.io)).toContain("collie promote");
    expect(h.data()!.pack).not.toBeNull();
  });

  test("not being in a pack is a state error, not a no-op success", async () => {
    const h = harness(null);
    expect(await cmdLeave(h.deps)).toBe(EXIT.STATE);
  });
});

// ── pack status ──────────────────────────────────────────────────────────────

describe("collie pack status", () => {
  test("a solo instance says so and names both ways into a pack", async () => {
    const h = harness(null);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("mode: solo");
    expect(text(h.io)).toContain("collie join");
  });

  test("renders mode, members, pinning, secret pickup and reachability", async () => {
    const h = harness(
      leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop", secretGeneration: 0 })] }),
      [jsonReply({ protocol: 1, member: "nas" }, 200, "nas"), new Error("timed out")],
    );
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    const rendered = text(h.io);
    expect(rendered).toContain("mode   lead");
    // The effective pack-listener bind (COLLIE_HOST, resolved) is shown so the operator sees it. The
    // harness sets no COLLIE_HOST, so it resolves to loopback and carries no wildcard note.
    expect(rendered).toContain("bind   127.0.0.1");
    expect(rendered).not.toContain("ALL interfaces");
    expect(rendered).toContain("nas");
    expect(rendered).toContain("reachable");
    expect(rendered).toContain("HAS NOT picked up the current secret");
    expect(rendered).toContain("unreachable");
    // The one thing a status render must never do.
    expect(rendered).not.toContain(PACK.secret);
    expect(rendered).not.toContain(leadStore().self.keyPem.trim());
  });

  test("a wildcard COLLIE_HOST is shown as ALL interfaces in the bind line", async () => {
    const h = harness(peerStore(), [], {
      ctx: context(
        { COLLIE_HOST: "0.0.0.0", COLLIE_PACK_TIMEOUT_MS: "60000" },
        { socket: "/home/pat/.config/herdr/herdr.sock" },
      ),
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    const rendered = text(h.io);
    expect(rendered).toContain("bind   0.0.0.0 — ALL interfaces, gated only by pinned mTLS + the pack secret");
  });

  test("an unenrolled tombstone explains WHY it went quiet and what recovery is", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas", status: "unenrolled" })] }));
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).toContain("dropped by a rotation");
    expect(text(h.io)).toContain("collie join");
    // A tombstone is never dialled.
    expect(h.requests).toEqual([]);
  });

  test("the two refusal causes a 401 deliberately conflates are separated for the operator", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }), [
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    ]);
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).toContain("unpinned");
    expect(text(h.io)).toContain("certificate or a secret this member no longer holds");
  });

  test("`--no-probe` dials nobody", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(h.requests).toEqual([]);
    expect(text(h.io)).toContain("not probed");
  });

  // ── The running bridge vs. the store on disk ──────────────────────────────
  // A membership change can arrive over the wire, at a process that read its roster at boot and does
  // not re-read it. `pack status` is where an operator finds out, because nothing else can tell them.

  test("says ENROLLED BUT INACTIVE when the bridge booted before the enrollment landed", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    // The marker the bridge left at boot: this lead came up with an EMPTY roster, then answered a
    // `collie join` in-process — exactly the gap the two-instance harness found.
    h.files.write(
      "/state/pack-runtime.json",
      JSON.stringify({ bootedAt: T0, pid: 999, mode: "solo", roster: [] }),
    );
    expect(await cmdPackStatus(h.deps, ["--no-probe"])).toBe(EXIT.OK);
    const rendered = text(h.io);
    expect(rendered).toContain("enrolled but INACTIVE");
    expect(rendered).toContain("not yet active:  peer:nas");
    expect(rendered).toContain("collie restart");
    // Still a read: noticing must not restart anything on its own.
    expect(h.restarts).toEqual([]);
  });

  test("names the mode split when a demoted lead is still running as one", async () => {
    const h = harness(peerStore());
    h.files.write(
      "/state/pack-runtime.json",
      JSON.stringify({ bootedAt: T0, pid: 999, mode: "lead", roster: ["peer:nas"] }),
    );
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("a peer on disk and a lead in memory");
  });

  test("no marker, no warning — a status run before the first `start` invents nothing", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).not.toContain("INACTIVE");
  });

  test("a marker that matches the store is silent", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    h.files.write(
      "/state/pack-runtime.json",
      JSON.stringify({ bootedAt: T0, pid: 999, mode: "lead", roster: ["peer:nas"] }),
    );
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).not.toContain("INACTIVE");
  });

  test("it changes nothing — status is a read", async () => {
    const before = leadStore({ peers: [member({ memberId: "nas" })] });
    const h = harness(before);
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(h.data()).toEqual(before);
    expect(h.restarts).toEqual([]);
  });
});

// ── pack rotate ──────────────────────────────────────────────────────────────

describe("collie pack rotate", () => {
  const roster = [member({ memberId: "nas" }), member({ memberId: "laptop" })];

  test("rotates locally FIRST, then distributes with the SUPERSEDED secret", async () => {
    const h = harness(leadStore({ peers: roster }), [jsonReply({ generation: 2 }, 200, "nas"), jsonReply({ generation: 2 }, 200, "laptop")]);
    expect(await cmdPackRotate(h.deps)).toBe(EXIT.OK);
    const next = h.data()!.pack!;
    expect(next.secretGeneration).toBe(2);
    expect(next.secret).not.toBe(PACK.secret);
    for (const req of h.requests) {
      // Authenticated by the OLD secret — the peer has not been told the new one yet, and §8.4 keeps
      // no grace window that would accept both.
      expect(req.headers.authorization).toBe(`Bearer ${PACK.secret}`);
      expect(JSON.parse(req.body)).toEqual({ secret: next.secret, generation: 2 });
    }
  });

  test("a peer that took the secret is marked current; one that did not is dropped to unenrolled", async () => {
    const h = harness(leadStore({ peers: roster }), [jsonReply({ generation: 2 }, 200, "nas"), new Error("down")]);
    await cmdPackRotate(h.deps);
    const peers = h.data()!.peers;
    expect(peers.find((p) => p.memberId === "nas")).toMatchObject({ secretGeneration: 2, status: "enrolled" });
    expect(peers.find((p) => p.memberId === "laptop")).toMatchObject({ status: "unenrolled" });
    expect(text(h.io)).toContain("dropped to unenrolled: laptop");
    expect(text(h.io)).toContain("collie join");
  });

  test("rotation runs on the lead — a peer is told where to run it", async () => {
    const h = harness(peerStore());
    expect(await cmdPackRotate(h.deps)).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("runs on the lead");
    expect(h.data()!.pack!.secretGeneration).toBe(1);
  });

  test("the new secret is never printed", async () => {
    const h = harness(leadStore({ peers: roster }), [jsonReply({}, 200, "nas"), jsonReply({}, 200, "laptop")]);
    await cmdPackRotate(h.deps);
    expect(text(h.io)).not.toContain(h.data()!.pack!.secret);
    expect(JSON.stringify(h.audit)).not.toContain(h.data()!.pack!.secret);
  });
});

// ── pack remove ──────────────────────────────────────────────────────────────

describe("collie pack remove", () => {
  test("unpins and forgets, and says the far side keeps its own copy", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPackRemove(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(h.data()!.peers).toEqual([]);
    expect(serializeTrustStore(h.data()!)).not.toContain(fp("nas"));
    expect(text(h.io)).toContain("Nothing was sent to it");
    // Revocation is local by design — it must not be a request that a down peer can refuse.
    expect(h.requests).toEqual([]);
    expect(h.restarts).toHaveLength(1);
  });

  test("an unknown member is a state error naming the verb that lists them", async () => {
    const h = harness(leadStore());
    expect(await cmdPackRemove(h.deps, ["ghost"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("collie pack status");
  });

  test("no member id is a usage error", async () => {
    const h = harness(leadStore());
    expect(await cmdPackRemove(h.deps, [])).toBe(EXIT.USAGE);
  });
});

// ── promote ──────────────────────────────────────────────────────────────────

describe("collie promote", () => {
  test("refuses when the current lead is unreachable — no --force, no split brain", async () => {
    const h = harness(peerStore(), [new Error("host down")]);
    expect(await cmdPromote(h.deps, [])).toBe(EXIT.UNREACHABLE);
    expect(text(h.io)).toContain("two leads, two front doors");
    expect(text(h.io)).toContain("--force");
    expect(h.data()!.lead).not.toBeNull();
    expect(h.serves).toEqual([]);
  });

  test("tells the demoted machine's operator to restart it, then unserve — in that order", async () => {
    const h = harness(peerStore(), [jsonReply({ demoted: "desk", roster: [] }, 200, "desk")]);
    expect(await cmdPromote(h.deps, [])).toBe(EXIT.OK);
    const rendered = text(h.io);
    // The old lead adopted the demotion on disk when it answered — and kept its lead-mode listener.
    expect(rendered).toContain("`collie restart`, then `collie unserve`");
    expect(rendered).toContain("still the lead it");
    // `restart` re-publishes on the way up, which is the whole reason `unserve` comes second.
    expect(rendered.indexOf("collie restart")).toBeLessThan(rendered.lastIndexOf("collie unserve"));
  });

  test("--force promotes anyway and says the old lead may still believe it leads", async () => {
    const h = harness(peerStore(), [new Error("host down")]);
    expect(await cmdPromote(h.deps, ["--force"])).toBe(EXIT.OK);
    expect(h.data()!.lead).toBeNull();
    expect(h.data()!.peers).toEqual([]);
    expect(text(h.io)).toContain("may still believe it leads");
    expect(text(h.io)).toContain("re-join");
  });

  test("a clean handover demotes the lead, adopts its roster, and tells every reachable member", async () => {
    const h = harness(peerStore(), [
      jsonReply(
        {
          demoted: "desk",
          roster: [{ memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas.example:1" }],
        },
        200,
        "desk",
      ),
      jsonReply({ lead: "laptop", applied: true }, 200, "nas"),
    ]);
    expect(await cmdPromote(h.deps, [])).toBe(EXIT.OK);
    const data = h.data()!;
    expect(data.lead).toBeNull();
    expect(data.peers.map((p) => p.memberId).sort()).toEqual(["desk", "nas"]);
    // The role change reuses the pack identity and the pack secret — not a re-enrollment.
    expect(data.pack).toEqual(PACK);
    expect(data.self.memberId).toBe("laptop");
    expect(h.requests[1]!.url).toBe("https://nas.example:1/pack/v1/lead");
    expect(JSON.parse(h.requests[1]!.body)).toEqual({
      lead: { memberId: "laptop", fingerprint: fp("laptop"), certPem: material("laptop").certPem, address: "laptop.tail.ts.net" },
    });
  });

  test("it publishes the front door here and prints what does NOT follow the crown", async () => {
    const h = harness(peerStore(), [jsonReply({ demoted: "desk", roster: [] }, 200, "desk")]);
    await cmdPromote(h.deps, []);
    expect(h.serves).toHaveLength(1);
    const rendered = text(h.io);
    expect(rendered).toContain("push subscriptions");
    expect(rendered).toContain("audit log");
    expect(rendered).toContain("Nothing migrates");
    expect(rendered).toContain("Re-point your phone");
    // Only the old lead's own operator can tear its mapping down (ADR 0001's ownership record).
    expect(rendered).toContain("collie unserve");
  });

  test("a member unreachable during promotion is named, with the re-join rule", async () => {
    const h = harness(peerStore(), [
      jsonReply(
        {
          demoted: "desk",
          roster: [{ memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas.example:1" }],
        },
        200,
        "desk",
      ),
      new Error("nope"),
    ]);
    await cmdPromote(h.deps, []);
    expect(text(h.io)).toContain("Unreachable during promotion: nas");
  });

  test("a lead has no crown to take", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPromote(h.deps, [])).toBe(EXIT.STATE);
    expect(h.requests).toEqual([]);
  });
});

// ── reconnect ────────────────────────────────────────────────────────────────

describe("collie reconnect", () => {
  test("moves the lead's address on a peer and leaves the pin alone", async () => {
    const h = harness(peerStore(), [jsonReply({ protocol: 1, member: "desk" }, 200, "desk")]);
    expect(await cmdReconnect(h.deps, ["desk.other:8787"])).toBe(EXIT.OK);
    expect(h.data()!.lead).toMatchObject({ address: "desk.other:8787", fingerprint: fp("desk") });
    expect(h.requests[0]!.url).toBe("https://desk.other:8787/pack/v1/hello");
    expect(text(h.io)).toContain("pinned certificate is unchanged");
  });

  test("moves a named member on the lead", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }), [jsonReply({ protocol: 1, member: "nas" }, 200, "nas")]);
    expect(await cmdReconnect(h.deps, ["nas", "nas.other:1"])).toBe(EXIT.OK);
    expect(h.data()!.peers[0]!.address).toBe("nas.other:1");
  });

  test("an address that still does not answer is reported as unreachable, and the move stands", async () => {
    const h = harness(peerStore(), [new Error("still down")]);
    expect(await cmdReconnect(h.deps, ["desk.other:8787"])).toBe(EXIT.UNREACHABLE);
    expect(h.data()!.lead!.address).toBe("desk.other:8787");
  });

  test("an unknown member or an unchanged address writes nothing", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdReconnect(h.deps, ["ghost", "x:1"])).toBe(EXIT.STATE);
    expect(await cmdReconnect(h.deps, ["nas", "nas.example:8787"])).toBe(EXIT.STATE);
  });
});

// ── `collie pack <sub>` ──────────────────────────────────────────────────────

describe("collie pack", () => {
  test("an unknown subcommand exits 2 and lists the real ones", async () => {
    const h = harness(leadStore());
    expect(await cmdPack(h.deps, ["nonsense"])).toBe(EXIT.USAGE);
    expect(text(h.io)).toContain("unknown pack subcommand `nonsense`");
    for (const sub of ["invite", "status", "rotate", "remove"]) expect(text(h.io)).toContain(sub);
  });

  test("no subcommand is usage without accusing anyone of typing something", async () => {
    const h = harness(leadStore());
    expect(await cmdPack(h.deps, [])).toBe(EXIT.USAGE);
    expect(text(h.io)).not.toContain("unknown pack subcommand");
  });

  test("it routes to the verbs", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPack(h.deps, ["status", "--no-probe"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("mode   lead");
  });
});
