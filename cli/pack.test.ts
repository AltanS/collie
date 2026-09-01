import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "../bridge/audit.ts";
import {
  createTrustStore,
  HANDOVER_TTL_MS,
  PACK_PROTOCOL_VERSION,
  selfIdentity,
  type EnrollResponse,
} from "../bridge/pack/enrollment.ts";
import { fp, leadStore, material, member, PACK, peerStore, T0 } from "../bridge/pack/fixtures.ts";
import type { PackTlsOptions } from "../bridge/pack/transport.ts";
import {
  serializeTrustStore,
  TrustStore,
  type TrustStoreData,
  type TrustStoreIo,
} from "../bridge/pack/trust-store.ts";
import { capture, CONFIG, context, fakeExec, fakeFiles, fakeOps, ROOT } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  cmdJoin,
  cmdLeave,
  cmdPack,
  cmdPackApprovePromote,
  cmdPackInvite,
  cmdPackRemove,
  cmdPackRotate,
  cmdPackSetAddress,
  cmdPackStatus,
  cmdPromote,
  cmdReconnect,
  enrollUrl,
  parsePackArgs,
  readToken,
  selfAddress,
} from "./pack.ts";
import type { PackAddDeps } from "./remote.ts";
import { dialableBridgeHost } from "./tailnet.ts";

// The pack verbs, against fakes for every seam. NOTHING here reaches a service manager, a tailnet, a
// real trust store or a network: `restart`/`serve`/`unserve` are counters, the transport is a
// function, and the store is an in-memory `TrustStoreIo`. That is the same safety boundary
// cli/fakes.ts draws for the lifecycle verbs, extended one milestone.

const TAILSCALE_JSON = JSON.stringify({ Self: { DNSName: "laptop.tail.ts.net." } });

interface Harness {
  deps: PackAddDeps;
  io: ReturnType<typeof capture>;
  exec: ReturnType<typeof fakeExec>;
  files: ReturnType<typeof fakeFiles>;
  audit: AuditEntry[];
  /** Every request the verbs made: method, URL, headers, body — and whether it carried a TLS pin. */
  requests: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    /** `init.tls` as `clientFor` built it. `undefined` is an UNPINNED dial (§8.1's lead exception). */
    tls: PackTlsOptions | undefined;
  }[];
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
function harness(initial: TrustStoreData | null, replies: Reply[] = [], over: Partial<PackAddDeps> = {}): Harness {
  let contents = initial === null ? null : serializeTrustStore(initial);
  const io: TrustStoreIo = {
    read: async () => contents,
    write: async (_p, d) => {
      contents = d;
    },
  };
  const store = new TrustStore("/state", io);
  const ops = fakeOps();
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

  const deps: PackAddDeps = {
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
    ops,
    // SAFETY: `AuditLog` hands its sink exactly the line it just serialised from an `AuditEntry`,
    // so parsing it back yields that entry — this is the log's own round trip, not foreign input.
    audit: new AuditLog((l) => void auditLines.push(JSON.parse(l) as AuditEntry), { now: () => T0 }),
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      requests.push({
        url,
        method: init.method ?? "GET",
        headers,
        // Every pack verb sends a `JSON.stringify` string; anything else is recorded as its text so
        // the assertion that follows fails loudly rather than silently reading "".
        body: init.body === undefined || init.body === null ? "" : String(init.body),
        // The pin itself, not merely its presence: an assertion that a peer dial is still pinned has
        // to see WHOSE certificate is anchored, or it would pass on any non-empty object.
        tls: init.tls,
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
    // `pack add`'s own seams, present so `cmdPack` can be dispatched here and REFUSING, so nothing
    // in this suite can reach another machine by accident. `cli/remote.test.ts` supplies real fakes.
    remote: () => {
      throw new Error("this suite must never open an ssh connection");
    },
    confirm: () => {
      throw new Error("this suite must never prompt");
    },
    prompt: () => {
      throw new Error("this suite must never prompt");
    },
    gitBundle: () => {
      throw new Error("this suite must never bundle");
    },
    reload: () => store.load(),
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
function jsonReply<TBody>(body: TBody, status = 200, memberId = "peer"): Response {
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

describe("selfAddress — the port is explicit exactly where the dial needs it", () => {
  test("a peer's pack listener carries this instance's port; the lead's front door does not", () => {
    const h = harness(null);
    // The trap this closes: a bare host dials :443 (`enrollUrl`/`packUrl` assume https), and a peer
    // publishes no front door — its listener is COLLIE_HOST:COLLIE_PORT and nothing else (§3).
    expect(selfAddress(h.deps, undefined, "pack-listener")).toBe("laptop.tail.ts.net:8787");
    // The lead's is the published ingress, which really is on :443 — `pack add` and `pack invite`
    // hand this string to a joiner, and it must keep dialling the front door.
    expect(selfAddress(h.deps, undefined, "front-door")).toBe("laptop.tail.ts.net");
  });

  test("the appended port is the instance's own, not the default", () => {
    const h = harness(null, [], { ctx: context({}, { port: 9000 }) });
    expect(selfAddress(h.deps, undefined, "pack-listener")).toBe("laptop.tail.ts.net:9000");
  });

  test("http mode publishes no TLS front door, so both kinds are the bridge port", () => {
    const h = harness(null, [], { ctx: context({}, { serveMode: "http" }) });
    expect(selfAddress(h.deps, undefined, "pack-listener")).toBe("laptop.tail.ts.net:8787");
    expect(selfAddress(h.deps, undefined, "front-door")).toBe("laptop.tail.ts.net:8787");
  });

  test("the derived peer address composes into a dialable URL rather than being mangled", () => {
    const h = harness(null);
    expect(enrollUrl(selfAddress(h.deps, undefined, "pack-listener")!)).toBe(
      "https://laptop.tail.ts.net:8787/pack/v1/enroll",
    );
  });

  test("the operator's --address is taken VERBATIM — reachability is theirs to own (§8.2)", () => {
    const h = harness(null);
    // Nothing is appended, re-scheme'd or re-bracketed: a value that already carries a port, a
    // scheme, an IPv6 literal, or all three comes back exactly as typed, for either kind.
    for (const given of [
      "nas.example:1",
      "nas.example",
      "https://nas.example:8443",
      "http://nas.example:8787",
      "[fd7a:115c::1]:8787",
      "https://[fd7a:115c::1]:8443",
    ]) {
      expect(selfAddress(h.deps, given, "pack-listener")).toBe(given);
      expect(selfAddress(h.deps, given, "front-door")).toBe(given);
    }
  });

  test("an empty --address is no address at all, and falls back to the derived one", () => {
    // `parsePackArgs` gives a value-taking flag with nothing after it the empty string.
    const h = harness(null);
    expect(selfAddress(h.deps, "", "pack-listener")).toBe("laptop.tail.ts.net:8787");
  });

  test("COLLIE_PUBLIC_URL is the front door's configured truth, in both serve modes", () => {
    // The field failure this closes: behind a reverse proxy the derived tailnet name is correct and
    // undialable from the peer (one-way ACL), and the operator has to remember --address every time.
    const env = { COLLIE_PUBLIC_URL: "https://collie.example.com" };
    const https = harness(null, [], { ctx: context(env) });
    expect(selfAddress(https.deps, undefined, "front-door")).toBe("https://collie.example.com");
    const http = harness(null, [], { ctx: context(env, { serveMode: "http" }) });
    expect(selfAddress(http.deps, undefined, "front-door")).toBe("https://collie.example.com");
    // Its own port survives, because an origin is scheme + host + PORT.
    const ported = harness(null, [], { ctx: context({ COLLIE_PUBLIC_URL: "https://collie.example.com:8443" }) });
    expect(selfAddress(ported.deps, undefined, "front-door")).toBe("https://collie.example.com:8443");
    expect(text(https.io)).toBe("");
  });

  test("--address still beats COLLIE_PUBLIC_URL — the flag is the operator overruling their own config", () => {
    const h = harness(null, [], { ctx: context({ COLLIE_PUBLIC_URL: "https://collie.example.com" }) });
    expect(selfAddress(h.deps, "nas.example:8443", "front-door")).toBe("nas.example:8443");
  });

  test("a pack listener NEVER takes a public URL — a peer publishes no front door (§3, ADR 0013)", () => {
    const h = harness(null, [], { ctx: context({ COLLIE_PUBLIC_URL: "https://collie.example.com" }) });
    expect(selfAddress(h.deps, undefined, "pack-listener")).toBe("laptop.tail.ts.net:8787");
    expect(text(h.io)).toBe("");
  });

  test("an unparseable COLLIE_PUBLIC_URL warns and falls through — a banner variable can't break enrollment", () => {
    const h = harness(null, [], { ctx: context({ COLLIE_PUBLIC_URL: "collie.example.com" }) });
    expect(selfAddress(h.deps, undefined, "front-door")).toBe("laptop.tail.ts.net");
    expect(text(h.io)).toContain("is not a URL");
  });

  test("a path on COLLIE_PUBLIC_URL is dropped, loudly — the pack link mounts off the origin", () => {
    const h = harness(null, [], { ctx: context({ COLLIE_PUBLIC_URL: "https://collie.example.com/collie/" }) });
    expect(selfAddress(h.deps, undefined, "front-door")).toBe("https://collie.example.com");
    expect(text(h.io)).toContain("is dropped");
  });

  test("an http:// public URL passes through — `join`'s plaintext refusal owns that risk downstream", () => {
    const h = harness(null, [], { ctx: context({ COLLIE_PUBLIC_URL: "http://collie.example.com:8787" }) });
    expect(selfAddress(h.deps, undefined, "front-door")).toBe("http://collie.example.com:8787");
  });

  test("no tailnet name is null for both kinds — never a localhost the far side would dial", () => {
    const h = harness(null, [], { exec: fakeExec({ absent: ["tailscale"] }) });
    expect(selfAddress(h.deps, undefined, "pack-listener")).toBeNull();
    expect(selfAddress(h.deps, undefined, "front-door")).toBeNull();
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
      // The joiner is becoming a PEER, so what it hands the lead is its own pack listener — host AND
      // port. Portless, the lead would dial it at :443 forever (see the `selfAddress` suite above).
      address: "laptop.tail.ts.net:8787",
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

  test("an unreachable lead does not hang forever — the dial has a bounded budget", async () => {
    // The join dial's own `setTimeout` is stubbed to fire on the next tick rather than after the real
    // 15s budget, so this test proves the abort wiring without actually waiting out the timeout. The
    // fake fetch mimics a socket that never resolves on its own — exactly what an unreachable lead
    // looks like — and only settles (by rejecting) once the passed-in signal aborts.
    // Deferred to the next macrotask (real 0ms), not fired synchronously: firing synchronously would
    // abort before `deps.fetch` below has even registered its `abort` listener, since `cmdJoin` starts
    // the timer BEFORE calling `fetch`.
    const realSetTimeout = globalThis.setTimeout;
    // SAFETY: the stand-in is only ever called by `cmdJoin`'s single `setTimeout(fn, ms)` — one
    // callback, no handle read back — and the real timer it forwards to returns the real handle.
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
    let sawSignal = false;
    try {
      const h = harness(null, [], {
        fetch: (_url, init) => {
          sawSignal = init.signal instanceof AbortSignal;
          return new Promise((_resolve, reject) => {
            // SAFETY: `sawSignal` two lines up is the `instanceof AbortSignal` check, asserted below.
            const signal = init.signal as AbortSignal;
            signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        },
      });
      expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.UNREACHABLE);
      expect(sawSignal).toBe(true);
      expect(text(h.io)).toContain("could not reach desk.ts.net");
      expect(text(h.io)).toContain("timed out after 15s");
      // Never the raw, unhelpful AbortError text.
      expect(text(h.io)).not.toContain("The operation was aborted");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("the happy path's dial carries an abort signal too, not only the unreachable one", async () => {
    let sawSignal = false;
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")], {
      fetch: (_url, init) => {
        sawSignal = init.signal instanceof AbortSignal;
        return Promise.resolve(jsonReply(ENROLLED, 200, "desk"));
      },
    });
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.OK);
    expect(sawSignal).toBe(true);
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
    expect(await cmdJoin(h.deps, [])).toBe(EXIT.USAGE);
    expect(h.requests).toEqual([]);
    expect(text(h.io)).toContain("usage: collie join <lead-address> <token|-|@file>");
    expect(text(h.io)).not.toContain("needs the invite token as its second argument");
  });

  test("an address with no token explains the token is missing and shows how to pass it", async () => {
    const h = harness(null);
    expect(await cmdJoin(h.deps, ["desk.ts.net"])).toBe(EXIT.USAGE);
    expect(h.requests).toEqual([]);
    expect(text(h.io)).toContain("usage: collie join <lead-address> <token|-|@file>");
    expect(text(h.io)).toContain("error: join needs the invite token as its second argument.");
    expect(text(h.io)).toContain("collie join desk.ts.net -");
    expect(text(h.io)).toContain("collie pack invite");
  });

  // ── The lead's fingerprint on the invite authenticates the lead to the joiner (F1) ──
  // The operator carries `<token>.<lead-fingerprint>`. `join` sends ONLY the token on the wire and
  // requires the lead's answer to present the fingerprinted certificate — closing the MITM/relay a
  // self-consistent enrollment response could not.

  test("the wire EnrollRequest.token is still just T — the fingerprint never leaves this machine", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.OK);
    // SAFETY: the body is the `EnrollRequest` `cmdJoin` just serialised, whose `token` is the string
    // read from stdin; the three assertions below are what that string is being read for.
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

  // ── http:// enrollment is refused without --insecure (the token/secret cross the wire clear) ──

  test("an http:// address is REFUSED without --insecure, and never dialled", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    expect(await cmdJoin(h.deps, ["http://desk.ts.net", "-"])).toBe(EXIT.REFUSED);
    expect(text(h.io)).toContain("refusing to enroll over http://");
    expect(text(h.io)).toContain("--insecure");
    // Nothing was dialled and nothing was persisted — the guard runs before the fetch.
    expect(h.requests).toEqual([]);
    expect(h.data()!.pack).toBeNull();
  });

  test("http:// proceeds to the fetch when --insecure is passed", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    expect(await cmdJoin(h.deps, ["http://desk.ts.net", "-", "--insecure"])).toBe(EXIT.OK);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.url).toBe("http://desk.ts.net/pack/v1/enroll");
  });

  test("an explicit https:// address is unaffected — it dials without --insecure", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    expect(await cmdJoin(h.deps, ["https://desk.ts.net", "-"])).toBe(EXIT.OK);
    expect(h.requests[0]!.url).toBe("https://desk.ts.net/pack/v1/enroll");
    expect(text(h.io)).not.toContain("refusing to enroll over http://");
  });

  test("a bare host is unaffected — assumed https://, dials without --insecure", async () => {
    const h = harness(null, [jsonReply(ENROLLED, 200, "desk")]);
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.OK);
    expect(h.requests[0]!.url).toBe("https://desk.ts.net/pack/v1/enroll");
    expect(text(h.io)).not.toContain("refusing to enroll over http://");
  });

  test("a scheme-less address that does not answer says https:// was assumed", async () => {
    const h = harness(null, [new Error("connect ECONNREFUSED")]);
    expect(await cmdJoin(h.deps, joinArgs)).toBe(EXIT.UNREACHABLE);
    expect(text(h.io)).toContain("https:// was assumed");
    expect(text(h.io)).toContain("--insecure");
  });
});

// ── the runtime's voice never reaches an operator (F18) ──────────────────────

describe("an unreachable member is described in Collie's words, not Bun's", () => {
  // The exact string Bun throws, which reached `pack status`'s link line, the 503 body a phone
  // reads and `collie leave`'s warning — all three read the same `reason` field.
  const BUN_CONNECT = new Error("Unable to connect. Is the computer able to access the url?");

  test("`pack status` says what the far side did", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }), [BUN_CONNECT]);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("unreachable · hello: nothing accepted a connection at this address");
    expect(text(h.io)).not.toContain("Is the computer able to access the url?");
  });

  test("`collie leave` warns in the same words", async () => {
    const h = harness(peerStore(), [BUN_CONNECT]);
    expect(await cmdLeave(h.deps)).toBe(EXIT.OK);
    expect(text(h.io)).toContain("nothing accepted a connection at this address");
    expect(text(h.io)).not.toContain("the computer");
  });
});

// ── the unreachable-lead remedy (F11) ────────────────────────────────────────

describe("collie pack status — what an unreachable LEAD is told to do", () => {
  const behindAFrontDoor = (): TrustStoreData =>
    peerStore({ lead: member({ memberId: "desk", role: "lead", address: "https://desk.tailnet.ts.net" }) });

  test("a lead's scheme is not a diagnosis — the set-address hint is suppressed for that row", async () => {
    const h = harness(behindAFrontDoor(), [new Error("no route to host")]);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    // A lead's address is SUPPOSED to carry a scheme: it is a front door. The old hint told the
    // operator to strip it, and the verb it named refuses on this machine anyway.
    expect(text(h.io)).not.toContain("an address with a scheme is a front door's");
    expect(text(h.io)).not.toContain("pack set-address desk");
  });

  test("the remedy it does offer is the verb that runs HERE", async () => {
    const h = harness(behindAFrontDoor(), [new Error("no route to host")]);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("collie reconnect <address>");
    expect(text(h.io)).toContain("check that the door");
  });

  test("a PEER's scheme'd address still gets the lead's own verb, on the lead", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas", address: "https://nas.example" })] }), [
      new Error("no route to host"),
    ]);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("collie pack set-address nas <host:port>");
    expect(text(h.io)).not.toContain("collie reconnect <address>");
  });
});

// ── the peer→lead dial is not pinned (F10) ───────────────────────────────────

describe("clientFor — which dials carry a pin (§8.1) and which cannot", () => {
  // The lab's front door, and every real one: a `tailscale serve` or a conforming reverse proxy
  // (docs/deployment.md Variant C) that terminates TLS with a certificate that is NOT the lead's own.
  const behindAFrontDoor = (): TrustStoreData =>
    peerStore({ lead: member({ memberId: "desk", role: "lead", address: "https://desk.tailnet.ts.net" }) });

  test("a dial to this store's LEAD carries no TLS material at all", async () => {
    const h = harness(behindAFrontDoor(), [jsonReply({ removed: "laptop" }, 200, "desk")]);
    expect(await cmdLeave(h.deps)).toBe(EXIT.OK);
    expect(h.requests[0]!.url).toBe("https://desk.tailnet.ts.net/pack/v1/leave");
    // Pinning `ca: [desk.certPem]` here is the one thing that can never work: the certificate on the
    // wire belongs to the front door. Unpinned means the platform verifies it the ordinary way.
    expect(h.requests[0]!.tls).toBeUndefined();
    // …and §8.6's second factor is on the request instead, so the link is still two-factor.
    expect(h.requests[0]!.headers.authorization).toBe(`Bearer ${PACK.secret}`);
    expect(h.requests[0]!.headers["x-pack-signature"]).toBeDefined();
  });

  test("…and that is a fact about its ROLE, not about its address carrying a scheme", async () => {
    const bare = harness(peerStore(), [jsonReply({ removed: "laptop" }, 200, "desk")]);
    expect(await cmdLeave(bare.deps)).toBe(EXIT.OK);
    // `desk.example:8787` has no scheme, and it is still the lead — whose listener pins nothing.
    expect(bare.requests[0]!.url).toBe("https://desk.example:8787/pack/v1/leave");
    expect(bare.requests[0]!.tls).toBeUndefined();
  });

  test("a dial to a PEER still carries that peer's certificate as the anchor", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }), [
      jsonReply({ protocol: 1, member: "nas" }, 200, "nas"),
    ]);
    expect(await cmdReconnect(h.deps, ["nas", "nas.other:1"])).toBe(EXIT.OK);
    expect(h.requests[0]!.tls?.ca).toEqual([material("nas").certPem]);
    expect(h.requests[0]!.tls?.cert).toBe(material("desk").certPem);
  });

  test("`pack status` on a peer probes its lead through the front door, unpinned", async () => {
    const h = harness(behindAFrontDoor(), [jsonReply({ protocol: 1, member: "desk" }, 200, "desk")]);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(h.requests[0]!.url).toBe("https://desk.tailnet.ts.net/pack/v1/hello");
    expect(h.requests[0]!.tls).toBeUndefined();
    expect(text(h.io)).toContain("reachable");
  });

  test("`reconnect` re-points a peer at a new front door and reaches it there", async () => {
    const h = harness(behindAFrontDoor(), [
      jsonReply({ protocol: 1, member: "desk" }, 200, "desk"),
      jsonReply({}, 200, "desk"),
    ]);
    expect(await cmdReconnect(h.deps, ["https://desk.other.ts.net"])).toBe(EXIT.OK);
    expect(h.requests[0]!.url).toBe("https://desk.other.ts.net/pack/v1/hello");
    expect(h.requests.every((r) => r.tls === undefined)).toBe(true);
    expect(text(h.io)).toContain("it answered there.");
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

  // F12: `pack add` writes COLLIE_HOST=<the address the lead dials> — a wide bind. Peer mode
  // tolerates it; solo does not. So the documented tear-down ended with the service failing every
  // five seconds forever, under a banner that said "activating" and "yet".
  test("the pack's wide bind is retired, so the machine comes back as a plain loopback collie", async () => {
    const h = harness(peerStore(), [jsonReply({ removed: "laptop" }, 200, "desk")], {
      ctx: context({ COLLIE_HOST: "192.168.77.2", COLLIE_PACK_TIMEOUT_MS: "60000" }),
    });
    h.files.write(`${CONFIG}/.env`, "COLLIE_HOST=192.168.77.2\nCOLLIE_PORT=8787\n");
    expect(await cmdLeave(h.deps)).toBe(EXIT.OK);
    expect(h.files.read(`${CONFIG}/.env`)).toBe("COLLIE_PORT=8787\n");
    expect(text(h.io)).toContain("COLLIE_HOST=192.168.77.2 removed");
    expect(text(h.io)).toContain("ADR 0013");
  });

  test("a bind the operator owns is not second-guessed", async () => {
    const env = { COLLIE_HOST: "192.168.77.2", COLLIE_ALLOW_NON_LOOPBACK_BIND: "1", COLLIE_PACK_TIMEOUT_MS: "60000" };
    const h = harness(peerStore(), [jsonReply({ removed: "laptop" }, 200, "desk")], { ctx: context(env) });
    h.files.write(`${CONFIG}/.env`, "COLLIE_HOST=192.168.77.2\n");
    expect(await cmdLeave(h.deps)).toBe(EXIT.OK);
    expect(h.files.read(`${CONFIG}/.env`)).toBe("COLLIE_HOST=192.168.77.2\n");
    expect(text(h.io)).not.toContain("removed from");
  });

  test("a loopback bind is left exactly as it was — the common case pays nothing", async () => {
    const h = harness(peerStore(), [jsonReply({ removed: "laptop" }, 200, "desk")]);
    h.files.write(`${CONFIG}/.env`, "COLLIE_PORT=8787\n");
    expect(await cmdLeave(h.deps)).toBe(EXIT.OK);
    expect(h.files.read(`${CONFIG}/.env`)).toBe("COLLIE_PORT=8787\n");
    expect(text(h.io)).not.toContain("COLLIE_HOST");
  });

  test("a bind Collie cannot reach says what will happen, and names the variable", async () => {
    const h = harness(peerStore(), [jsonReply({ removed: "laptop" }, 200, "desk")], {
      ctx: context({ COLLIE_HOST: "192.168.77.2", COLLIE_PACK_TIMEOUT_MS: "60000" }),
    });
    // The value is real, but it comes from a systemd `Environment=` rather than the .env this owns.
    expect(await cmdLeave(h.deps)).toBe(EXIT.OK);
    expect(text(h.io)).toContain("every five seconds, forever");
    expect(text(h.io)).toContain("COLLIE_ALLOW_NON_LOOPBACK_BIND=1");
  });

  // F22: the restart below prints the health banner, and the banner resolves what it probes from
  // `ctx.env`. Left at the value this run started with, the documented tear-down ended on
  // `⚠ Collie isn't answering on 192.168.77.2:8787 yet` about a machine that was healthy on
  // loopback — the same alarm F12 used to raise, now false, at the end of the same command.
  test("the closing banner probes the bind as REWRITTEN, not the one this run started with", async () => {
    const ctx = context({ COLLIE_HOST: "192.168.77.2", COLLIE_PACK_TIMEOUT_MS: "60000" });
    const probed: (string | undefined)[] = [];
    const h = harness(peerStore(), [jsonReply({ removed: "laptop" }, 200, "desk")], {
      ctx,
      // The banner is built INSIDE this seam (`cmdRestart` → `cmdStart`), so what it would resolve
      // is exactly what `ctx.env` says at the instant the restart runs.
      restart: () => {
        probed.push(dialableBridgeHost(ctx.env));
        return Promise.resolve(EXIT.OK);
      },
    });
    h.files.write(`${CONFIG}/.env`, "COLLIE_HOST=192.168.77.2\nCOLLIE_PORT=8787\n");
    expect(await cmdLeave(h.deps)).toBe(EXIT.OK);
    expect(probed).toEqual(["127.0.0.1"]);
    expect(ctx.env.COLLIE_HOST).toBeUndefined();
  });

  test("a bind Collie could NOT remove is still the bind — the env keeps it", async () => {
    // The other half of the same rule: the machine really does still bind that address, so a banner
    // that probed loopback here would be the mirror-image lie. Nothing was rewritten; nothing moves.
    const ctx = context({ COLLIE_HOST: "192.168.77.2", COLLIE_PACK_TIMEOUT_MS: "60000" });
    const h = harness(peerStore(), [jsonReply({ removed: "laptop" }, 200, "desk")], { ctx });
    expect(await cmdLeave(h.deps)).toBe(EXIT.OK);
    expect(ctx.env.COLLIE_HOST).toBe("192.168.77.2");
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

  test("a reachable member is asked BOTH questions — the probe, and one real read", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }), [
      jsonReply({ protocol: 1, member: "nas" }, 200, "nas"),
      jsonReply({ servers: [] }, 200, "nas"),
    ]);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(h.requests.map((r) => r.url)).toEqual([
      "https://nas.example:8787/pack/v1/hello",
      "https://nas.example:8787/pack/v1/snapshot",
    ]);
    expect(text(h.io)).toContain("served a snapshot");
  });

  test("a member that answers `hello` and then starves is never rendered as simply reachable", async () => {
    // The measured DERP shape: the patient probe gets through, every strict-budget read does not.
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }), [
      jsonReply({ protocol: 1, member: "nas" }, 200, "nas"),
      new Error("timed out after 1200ms"),
    ]);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    const rendered = text(h.io);
    expect(rendered).toContain("data    STARVED");
    expect(rendered).toContain("timed out after 1200ms");
    // The remedy is a budget, not a `reconnect` — the machine just answered.
    expect(rendered).toContain("COLLIE_POLL_MS");
  });

  // F21: on a PEER the roster's one entry is the LEAD, and `/pack/v1/snapshot` is deliberately not on
  // the closed peer → lead route set (`bridge/pack/router.ts`, RFC §8.6). Asking anyway got §8.1's
  // bare 401 back and rendered a healthy pack as `data STARVED`, under a two-budget remedy that
  // cannot move an authorization refusal.
  test("a peer asks its LEAD one question, and rests the row on it", async () => {
    const h = harness(peerStore(), [jsonReply({ protocol: 1, member: "desk" }, 200, "desk")]);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(h.requests.map((r) => r.url)).toEqual(["https://desk.example:8787/pack/v1/hello"]);
    const rendered = text(h.io);
    expect(rendered).toContain("link    reachable");
    expect(rendered).not.toContain("data    ");
    expect(rendered).not.toContain("STARVED");
    expect(rendered).not.toContain("COLLIE_POLL_MS`");
  });

  test("…and the refusal it would have got is never rendered as a starved link", async () => {
    // What the lab saw: `hello` 200, then the 401 the closed route set guarantees. Even handed that
    // reply, the peer must not ASK — so the reply is never read, and the budget remedy never prints.
    const h = harness(peerStore(), [
      jsonReply({ protocol: 1, member: "desk" }, 200, "desk"),
      jsonReply({ error: "unauthorized" }, 401, "desk"),
    ]);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(h.requests).toHaveLength(1);
    expect(text(h.io)).not.toContain("not arriving inside the per-poll budget");
  });

  test("a LEAD still asks BOTH questions of every peer — the poll really does run that way", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }), [
      jsonReply({ protocol: 1, member: "nas" }, 200, "nas"),
      jsonReply({ servers: [] }, 200, "nas"),
    ]);
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(h.requests).toHaveLength(2);
    expect(text(h.io)).toContain("served a snapshot");
  });

  test("--no-probe asks neither question", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPackStatus(h.deps, ["--no-probe"])).toBe(EXIT.OK);
    expect(h.requests).toEqual([]);
    expect(text(h.io)).toContain("not probed");
  });

  test("a clamped COLLIE_PACK_TIMEOUT_MS says so instead of silently doing nothing", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    await cmdPackStatus(h.deps, ["--no-probe"]);
    // The harness asks for 60000ms against the default 1500ms poll, so the clamp bites hard.
    expect(text(h.io)).toContain("COLLIE_PACK_TIMEOUT_MS=60000 has no effect beyond 1200ms");
    expect(text(h.io)).toContain("COLLIE_POLL_MS=75000");
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

  // ── Version skew (§7.1) ───────────────────────────────────────────────────
  // A build version is a fact about a running process, not a contract: a difference refuses nothing,
  // and `pack status` is the one place it is rendered. `incompatible` stays §7's protocol mismatch.

  /** Give this checkout a version to compare against — the same file `collie version` reads. */
  function withVersion(h: Harness, version: string): Harness {
    h.files.write(`${ROOT}/herdr-plugin.toml`, `id = "herdr.collie"\nversion = "${version}"\n`);
    return h;
  }

  test("a member on this build's version renders quietly — no finding, no noise", async () => {
    const h = withVersion(
      harness(leadStore({ peers: [member({ memberId: "nas" })] }), [
        jsonReply({ protocol: 1, member: "nas", version: "1.0.0-alpha.12" }, 200, "nas"),
      ]),
      "1.0.0-alpha.12",
    );
    await cmdPackStatus(h.deps, []);
    const rendered = text(h.io);
    expect(rendered).toContain("version 1.0.0-alpha.12");
    expect(rendered).not.toContain("warn:");
    expect(rendered).not.toContain("INCOMPATIBLE");
  });

  test("a skewed member is a `warn:` naming BOTH versions and the remedy — and stays reachable", async () => {
    const h = withVersion(
      harness(leadStore({ peers: [member({ memberId: "nas" })] }), [
        jsonReply({ protocol: 1, member: "nas", version: "1.0.0-alpha.11" }, 200, "nas"),
      ]),
      "1.0.0-alpha.12",
    );
    await cmdPackStatus(h.deps, []);
    const rendered = text(h.io);
    expect(rendered).toContain("version 1.0.0-alpha.11 — warn: this machine runs 1.0.0-alpha.12");
    expect(rendered).toContain("`collie pack update nas`");
    // Skew refuses nothing: the link is reachable and the member is NOT the incompatible state,
    // which §7 reserves for a protocol mismatch.
    expect(rendered).toContain("reachable");
    expect(rendered).not.toContain("INCOMPATIBLE");
  });

  test("a member answering without the field renders as pre-amendment, never as `unknown`", async () => {
    const h = withVersion(
      harness(leadStore({ peers: [member({ memberId: "nas" })] }), [
        jsonReply({ protocol: 1, member: "nas" }, 200, "nas"),
      ]),
      "1.0.0-alpha.12",
    );
    await cmdPackStatus(h.deps, []);
    const rendered = text(h.io);
    expect(rendered).toContain("version pre-1.0.0-alpha.12 (not reported)");
    expect(rendered).not.toContain("version unknown");
    expect(rendered).toContain("reachable");
  });

  test("a protocol mismatch is still INCOMPATIBLE, and no version line dresses it up (§7)", async () => {
    const h = withVersion(
      harness(leadStore({ peers: [member({ memberId: "nas" })] }), [
        jsonReply({ error: "pack protocol mismatch", code: "protocol_mismatch", expected: 1, received: 2 }, 409, "nas"),
      ]),
      "1.0.0-alpha.12",
    );
    await cmdPackStatus(h.deps, []);
    const rendered = text(h.io);
    expect(rendered).toContain("INCOMPATIBLE");
    expect(rendered).not.toContain("    version ");
  });

  test("on a PEER, the lead's row carries the same version rendering", async () => {
    const h = withVersion(
      harness(peerStore(), [jsonReply({ protocol: 1, member: "desk", version: "1.0.0-alpha.11" }, 200, "desk")]),
      "1.0.0-alpha.12",
    );
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).toContain("version 1.0.0-alpha.11 — warn: this machine runs 1.0.0-alpha.12");
  });

  test("a checkout with no version of its own names the peer's and warns about nobody", async () => {
    // `ours` is `unknown` — not a version, so there is no older machine to name. Report what the
    // member said and stay quiet rather than warn about a skew we cannot state the other half of.
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }), [
      jsonReply({ protocol: 1, member: "nas", version: "1.0.0-alpha.12" }, 200, "nas"),
    ]);
    await cmdPackStatus(h.deps, []);
    const rendered = text(h.io);
    expect(rendered).toContain("version 1.0.0-alpha.12");
    expect(rendered).not.toContain("warn:");
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

  // ── The provisional (never-contacted) marker ──────────────────────────────

  test("a `contactedAt: null` member with a failing probe is flagged provisional, with the remove verb", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas", contactedAt: null })] }), [new Error("down")]);
    await cmdPackStatus(h.deps, []);
    const rendered = text(h.io);
    expect(rendered).toContain("provisional — enrolled but never once reachable");
    expect(rendered).toContain("collie pack remove nas");
  });

  test("an ABSENT contactedAt (back-compat) is NEVER provisional", async () => {
    // `member()` omits the field — the shape a member enrolled before it existed has on disk.
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }), [new Error("down")]);
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).not.toContain("provisional");
  });

  test("a numeric contactedAt (already contacted) is not provisional", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas", contactedAt: T0 })] }), [new Error("down")]);
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).not.toContain("provisional");
  });

  test("a successful probe against a provisional member persists a numeric contactedAt", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas", contactedAt: null })] }), [
      jsonReply({ protocol: 1, member: "nas" }, 200, "nas"),
    ]);
    await cmdPackStatus(h.deps, []);
    const stamped = h.data()!.peers.find((p) => p.memberId === "nas")!;
    expect(stamped.contactedAt).toBeTypeOf("number");
    expect(stamped.contactedAt).toBe(T0);
    // Reachable now, so the provisional line is suppressed this run — it was cleared, not half-finished.
    expect(text(h.io)).not.toContain("provisional");
    expect(h.audit.map((l) => l.action)).toContain("pack.contacted");
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
  test("unpins, and says the far side keeps its own copy", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPackRemove(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(h.data()!.peers).toEqual([]);
    expect(serializeTrustStore(h.data()!)).not.toContain(fp("nas"));
    expect(text(h.io)).toContain("Nothing was sent to it");
    // Revocation is local by design — it must not be a request that a down peer can refuse.
    expect(h.requests).toEqual([]);
    expect(h.restarts).toHaveLength(1);
  });

  // F16: the row in pack-ops.json is `{sshHost, path, port}` — exactly the connection that finishes
  // the tear-down on the other machine — and it was deleted in the same breath as printing the
  // sentence that needs it. The removed peer is invisible from both ends until `collie leave` runs
  // there, so the verb now prints the line and KEEPS the row.
  test("it prints the ssh line that finishes the job, and keeps the record it is built from", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }), [], {
      ops: fakeOps({
        nas: { sshHost: "op@192.168.77.2", path: "/home/op/.collie", port: 8787, recordedAt: T0 },
      }),
    });
    expect(await cmdPackRemove(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("ssh op@192.168.77.2 /home/op/.collie/bin/collie leave");
    expect(text(h.io)).toContain("/state/pack-ops.json");
    // The row survives — this is the whole finding.
    expect(await h.deps.ops.get("nas")).toMatchObject({ sshHost: "op@192.168.77.2" });
  });

  test("a member this lead never SSH'd to says so instead of inventing a command", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPackRemove(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("has no record of how it was reached over ssh");
    expect(text(h.io)).not.toContain("    ssh ");
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

// ── pack approve-promote ─────────────────────────────────────────────────────

describe("collie pack approve-promote — consent on the lead (§14.1)", () => {
  const leadWithNas = () => leadStore({ peers: [member({ memberId: "nas" })] });

  test("it arms a ten-minute consent, names the next step, and RESTARTS the bridge", async () => {
    const h = harness(leadWithNas());
    expect(await cmdPackApprovePromote(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(h.data()!.pendingHandover).toEqual({ memberId: "nas", createdAt: T0, expiresAt: T0 + HANDOVER_TTL_MS });
    const rendered = text(h.io);
    expect(rendered).toContain('approved "nas"');
    expect(rendered).toContain("ten minutes");
    expect(rendered).toContain('run `collie promote` on "nas" within 10 minutes');
    // The restart is load-bearing: the bridge reads its trust store once per process, so an approval
    // it never re-read would refuse the promotion forever.
    expect(h.restarts).toHaveLength(1);
    // Consent is local: nothing is sent to the member it names.
    expect(h.requests).toEqual([]);
    expect(h.audit.map((l) => l.action)).toContain("pack.handover.approve");
  });

  test("a peer has nothing to hand over, and a store with no pack has no handover at all", async () => {
    const onPeer = harness(peerStore());
    expect(await cmdPackApprovePromote(onPeer.deps, ["desk"])).toBe(EXIT.STATE);
    expect(text(onPeer.io)).toContain("approved on the lead");
    const solo = harness(null);
    expect(await cmdPackApprovePromote(solo.deps, ["nas"])).toBe(EXIT.STATE);
    expect(onPeer.restarts).toEqual([]);
  });

  test("a member id this lead does not pin is a typo, not a consent", async () => {
    const h = harness(leadWithNas());
    expect(await cmdPackApprovePromote(h.deps, ["ghost"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain('no enrolled member "ghost"');
    expect(h.data()!.pendingHandover ?? null).toBeNull();
    expect(h.restarts).toEqual([]);
  });

  test("no member id at all is a usage error, not an approval of nobody", async () => {
    const h = harness(leadWithNas());
    expect(await cmdPackApprovePromote(h.deps, [])).toBe(EXIT.USAGE);
  });

  test("`--cancel` is BARE — it clears the approval and never swallows the next token", async () => {
    const h = harness(leadWithNas());
    await cmdPackApprovePromote(h.deps, ["nas"]);
    expect(await cmdPackApprovePromote(h.deps, ["--cancel"])).toBe(EXIT.OK);
    expect(h.data()!.pendingHandover).toBeNull();
    expect(text(h.io)).toContain('cancelled the handover approval for "nas"');
    // The bridge must FORGET it, which is the same mechanism as holding it: a restart.
    expect(h.restarts).toHaveLength(2);
    expect(h.audit.map((l) => l.action)).toContain("pack.handover.cancel");
  });

  test("`--cancel` with nothing armed exits cleanly — the operator asked for this state", async () => {
    const h = harness(leadWithNas());
    expect(await cmdPackApprovePromote(h.deps, ["--cancel"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("nothing was armed");
    expect(h.restarts).toEqual([]);
  });

  test("`pack status` shows a live approval on the lead, and never on a peer", async () => {
    const armed = harness(
      leadStore({
        peers: [member({ memberId: "nas" })],
        pendingHandover: { memberId: "nas", createdAt: T0, expiresAt: T0 + HANDOVER_TTL_MS },
      }),
    );
    await cmdPackStatus(armed.deps, ["--no-probe"]);
    expect(text(armed.io)).toContain("handover approved: nas — expires in 10m");

    // Expired reads as absent — the window is a read, not a sweep.
    const stale = harness(
      leadStore({
        peers: [member({ memberId: "nas" })],
        pendingHandover: { memberId: "nas", createdAt: T0 - HANDOVER_TTL_MS, expiresAt: T0 },
      }),
    );
    await cmdPackStatus(stale.deps, ["--no-probe"]);
    expect(text(stale.io)).not.toContain("handover approved");

    // A peer cannot hold one: an approval is consent to demote THIS machine.
    const onPeer = harness(peerStore({ pendingHandover: { memberId: "x", createdAt: T0, expiresAt: T0 + 1000 } }));
    await cmdPackStatus(onPeer.deps, ["--no-probe"]);
    expect(text(onPeer.io)).not.toContain("handover approved");
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

  test("an UNAPPROVED promotion surfaces the lead's refusal verbatim and never mentions --force", async () => {
    // §14.3: the lead is reachable and said no. Aiming the operator at `--force` here would strand
    // every peer to work around a consent they can mint in one verb on the machine they are at.
    const refusal =
      'this lead has not approved "laptop" to take over — run `collie pack approve-promote laptop` here, ' +
      "then re-run `collie promote` on that machine within 10 minutes";
    const h = harness(peerStore(), [jsonReply({ error: refusal, code: "handover_not_approved" }, 403, "desk")]);
    expect(await cmdPromote(h.deps, [])).toBe(EXIT.REFUSED);
    expect(text(h.io)).toContain(refusal);
    expect(text(h.io)).not.toContain("--force");
    // Nothing moved here either: still a peer, still pinning its lead.
    expect(h.data()!.lead).not.toBeNull();
    expect(h.serves).toEqual([]);
  });

  test("a refusal beats --force — a lead that answers is a lead that is reachable", async () => {
    const h = harness(peerStore(), [
      jsonReply({ error: "this lead has not approved …", code: "handover_not_approved" }, 403, "desk"),
    ]);
    expect(await cmdPromote(h.deps, ["--force"])).toBe(EXIT.REFUSED);
    expect(h.data()!.lead).not.toBeNull();
  });

  test("prints the demoted lead's repair in order: COLLIE_HOST, restart, unserve, then reconnect here", async () => {
    const h = harness(peerStore(), [jsonReply({ demoted: "desk", roster: [] }, 200, "desk")]);
    expect(await cmdPromote(h.deps, [])).toBe(EXIT.OK);
    const rendered = text(h.io);
    // The old lead adopted the demotion on disk when it answered — and kept its lead-mode listener.
    expect(rendered).toContain("`collie restart`, then `collie unserve`");
    expect(rendered).toContain("still the lead it");
    expect(rendered).toContain("COLLIE_HOST");
    // §14.5 (2026-08-12): the roster names the old lead's front door, which step 2 tears down.
    expect(rendered).toContain("collie reconnect desk <host:port>");
    const at = (needle: string) => rendered.indexOf(needle);
    expect(at("COLLIE_HOST")).toBeLessThan(at("collie restart"));
    expect(at("collie restart")).toBeLessThan(at("collie unserve"));
    // `restart` re-publishes on the way up, which is the whole reason `unserve` comes second.
    expect(at("collie unserve")).toBeLessThan(at("collie reconnect desk"));
  });

  test("--force promotes anyway and says the old lead may still believe it leads", async () => {
    const h = harness(peerStore(), [new Error("host down")]);
    expect(await cmdPromote(h.deps, ["--force"])).toBe(EXIT.OK);
    expect(h.data()!.lead).toBeNull();
    expect(h.data()!.peers).toEqual([]);
    expect(text(h.io)).toContain("may still believe it leads");
    expect(text(h.io)).toContain("re-join");
  });

  test("a clean handover demotes the lead, adopts its roster, and dials NOBODY else", async () => {
    const h = harness(peerStore(), [
      jsonReply(
        {
          demoted: "desk",
          roster: [{ memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas.example:1" }],
        },
        200,
        "desk",
      ),
    ]);
    expect(await cmdPromote(h.deps, [])).toBe(EXIT.OK);
    const data = h.data()!;
    expect(data.lead).toBeNull();
    expect(data.peers.map((p) => p.memberId).toSorted()).toEqual(["desk", "nas"]);
    // The role change reuses the pack identity and the pack secret — not a re-enrollment.
    expect(data.pack).toEqual(PACK);
    expect(data.self.memberId).toBe("laptop");
    // §14.4/§14.5 (2026-08-12): the old lead is the ONLY machine this verb talks to. "nas" pins the
    // old lead's certificate at its own handshake, so a dial there is refused at TLS — the sweep that
    // used to run here could never land, and its absence is the contract.
    expect(h.requests.map((r) => r.url)).toEqual(["https://desk.example:8787/pack/v1/lead"]);
    expect(JSON.parse(h.requests[0]!.body)).toEqual({
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

  test("every member but the old lead is listed for re-join — unconditionally, not on failure", async () => {
    const roster = ["nas", "pi"].map((memberId) => ({
      memberId,
      fingerprint: fp(memberId),
      certPem: material(memberId).certPem,
      address: `${memberId}.example:1`,
    }));
    const h = harness(peerStore(), [jsonReply({ demoted: "desk", roster }, 200, "desk")]);
    await cmdPromote(h.deps, []);
    const rendered = text(h.io);
    expect(rendered).toContain("nas, pi");
    expect(rendered).toContain("`collie join`");
    // Nothing was attempted against them, so nothing may be reported as a per-peer outcome (§14.4).
    expect(rendered).not.toContain("✓ nas");
    expect(rendered).not.toContain("✗ nas");
  });

  test("--force names the same re-join rule with nobody left to sweep", async () => {
    const h = harness(peerStore(), [new Error("host down")]);
    expect(await cmdPromote(h.deps, ["--force"])).toBe(EXIT.OK);
    // The forced path never got a roster, so the rule is stated for "every other member" by name of
    // the rule rather than by list — the sweep is absent on both paths for the same §14.4 reason.
    expect(text(h.io)).toContain("Every other member must re-join this machine with a fresh token");
    expect(h.requests.map((r) => r.url)).toEqual(["https://desk.example:8787/pack/v1/lead"]);
  });

  test("a lead has no crown to take", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPromote(h.deps, [])).toBe(EXIT.STATE);
    expect(h.requests).toEqual([]);
  });
});

// ── pack set-address ─────────────────────────────────────────────────────────

describe("collie pack set-address", () => {
  test("rewrites the row, prints before → after, and restarts this lead", async () => {
    const h = harness(
      leadStore({ peers: [member({ memberId: "nas", address: "https://collie.example.com" })] }),
    );
    expect(await cmdPackSetAddress(h.deps, ["nas", "nas.tail.ts.net:8788"])).toBe(EXIT.OK);
    expect(h.data()!.peers[0]!.address).toBe("nas.tail.ts.net:8788");
    // The pin is untouched — an address is a hint, never an identity (§4).
    expect(h.data()!.peers[0]!.fingerprint).toBe(fp("nas"));
    const said = text(h.io);
    expect(said).toContain("from  https://collie.example.com");
    expect(said).toContain("to    nas.tail.ts.net:8788");
    expect(h.restarts).toHaveLength(1);
    // Local by construction: correcting where we dial a member sends that member nothing.
    expect(h.requests).toEqual([]);
    expect(h.audit.map((a) => a.action)).toContain("pack.address");
  });

  test("a scheme is refused with the reason, and nothing is written", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPackSetAddress(h.deps, ["nas", "https://collie.example.com"])).toBe(EXIT.USAGE);
    expect(text(h.io)).toContain("an address with a scheme is a front door's");
    expect(h.data()!.peers[0]!.address).toBe("nas.example:8787");
    expect(h.restarts).toEqual([]);
  });

  test("a portless address is refused — it would dial :443, not the peer's listener", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPackSetAddress(h.deps, ["nas", "nas.tail.ts.net"])).toBe(EXIT.USAGE);
    expect(text(h.io)).toContain("there is no port");
  });

  test("the four refusals: not the lead, unknown member, this machine, and no arguments", async () => {
    const peer = harness(peerStore());
    expect(await cmdPackSetAddress(peer.deps, ["desk", "desk.other:8787"])).toBe(EXIT.STATE);
    expect(text(peer.io)).toContain("collie reconnect <address>");

    const lead = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPackSetAddress(lead.deps, ["ghost", "ghost.example:1"])).toBe(EXIT.STATE);
    expect(await cmdPackSetAddress(lead.deps, ["desk", "desk.example:1"])).toBe(EXIT.STATE);
    expect(text(lead.io)).toContain("is this machine");
    expect(await cmdPackSetAddress(lead.deps, ["nas"])).toBe(EXIT.USAGE);
    expect(lead.restarts).toEqual([]);
  });

  test("the address it already has is a no-op, not a write and not a restart", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPackSetAddress(h.deps, ["nas", "nas.example:8787"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("already at");
    expect(h.restarts).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  test("`pack status` points an unreachable scheme'd member at the verb", async () => {
    const h = harness(
      leadStore({ peers: [member({ memberId: "nas", address: "https://collie.example.com" })] }),
      [new Error("getaddrinfo ENOTFOUND")],
    );
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("collie pack set-address nas <host:port>");
  });

  test("…and says nothing about an address that is answering", async () => {
    const h = harness(
      leadStore({ peers: [member({ memberId: "nas", address: "https://collie.example.com" })] }),
      [jsonReply({ protocol: 1, member: "nas" }, 200, "nas")],
    );
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(text(h.io)).not.toContain("set-address");
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

  test("an address that answers but serves no data says so, and the move still stands", async () => {
    const h = harness(peerStore(), [
      jsonReply({ protocol: 1, member: "desk" }, 200, "desk"),
      new Error("timed out after 1200ms"),
    ]);
    // The move succeeded and the machine answered — a budget problem must not tell a script the
    // address is wrong, so the exit code stays the `hello` verdict.
    expect(await cmdReconnect(h.deps, ["desk.other:8787"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("it answered there.");
    expect(text(h.io)).toContain("it served no data");
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
    for (const sub of ["invite", "status", "rotate", "remove", "approve-promote"]) expect(text(h.io)).toContain(sub);
  });

  test("no subcommand is usage without accusing anyone of typing something", async () => {
    const h = harness(leadStore());
    expect(await cmdPack(h.deps, [])).toBe(EXIT.USAGE);
    expect(text(h.io)).not.toContain("unknown pack subcommand");
  });

  // F20: `collie pack --help` answered `error: unknown pack subcommand \`--help\``. It is a spelling
  // of the block `collie pack` already prints, not a typo and not a second surface.
  test("`help`, `--help` and `-h` all print the block, and accuse nobody", async () => {
    const bare = harness(leadStore());
    expect(await cmdPack(bare.deps, [])).toBe(EXIT.USAGE);
    for (const spelling of ["help", "--help", "-h"]) {
      const h = harness(leadStore());
      expect(await cmdPack(h.deps, [spelling])).toBe(EXIT.USAGE);
      expect(text(h.io)).not.toContain("unknown pack subcommand");
      expect(text(h.io)).toBe(text(bare.io));
    }
  });

  test("it routes to the verbs", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(await cmdPack(h.deps, ["status", "--no-probe"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("mode   lead");
    expect(await cmdPack(h.deps, ["approve-promote", "nas"])).toBe(EXIT.OK);
    expect(h.data()!.pendingHandover).toMatchObject({ memberId: "nas" });
  });
});
