import { describe, expect, test } from "bun:test";

import { fp, leadStore, material, member, peerStore, T0 } from "./fixtures.ts";
import { LeadContact } from "./lead-contact.ts";
import { mintWarrant } from "./warrant.ts";
import { sha256Hex } from "../pairing.ts";
import type { SyncedDevice } from "./standby-devices.ts";
import type { StoredWarrant, TrustStoreData } from "./trust-store.ts";
import {
  armingReport,
  armThresholdMs,
  armThresholdWarning,
  ARM_FLOOR_MS,
  coldReason,
  createStandbyDoor,
  escapeHtml,
  frontDoorHealth,
  humanSilence,
  isArmed,
  silenceOf,
  standbyCsp,
  standbyHostOf,
  standbyPage,
  standbyPortOf,
  warrantNamesSelf,
  STANDBY_HEALTH_PATH,
  STANDBY_PATH,
  STANDBY_TAKEOVER_PATH,
  STANDBY_VERSION_HEADER,
  STANDBY_UPDATE_PATH,
  standbyUpdateAnswer,
  withStandbyVersion,
  type StandbyFacts,
} from "./standby.ts";

// The standby door, as data plus one thin handler. Nothing here needs `Bun.serve`: the door takes a
// plain `Request` and a `URL`, so the arming matrix, the auth matrix and the page are all pinned as
// the shipping rule rather than as a harness (CLAUDE.md).

const TOKEN = "a-device-token";
const DEVICE: SyncedDevice = { label: "phone", tokenHash: sha256Hex(TOKEN), createdAt: T0 };

/** A lead (`desk`) that has named `laptop` — the machine every peer store below belongs to. */
function warrantFor(deputy: string): StoredWarrant {
  const change = mintWarrant(leadStore({ peers: [member({ memberId: deputy })] }), deputy, T0);
  if (change === null) throw new Error("fixture: expected a mint");
  return { warrant: change.result, deputyCertPem: material(deputy).certPem };
}

/** A peer store for `laptop`, holding whatever warrant the case needs. */
function deputyStore(over: Partial<TrustStoreData> = {}): TrustStoreData {
  return peerStore({ warrant: warrantFor("laptop"), ...over });
}

function facts(over: Partial<StandbyFacts> = {}): StandbyFacts {
  return {
    warrantsSelf: true,
    silentForMs: 60_000,
    armMs: 30_000,
    deviceCount: 1,
    witnessCount: 2,
    leadMemberId: "desk",
    selfMemberId: "laptop",
    packName: "the herd",
    ...over,
  };
}

describe("the arming threshold is a formula, not a constant (RFC §6.3)", () => {
  test("at today's defaults both terms are 30 s", () => {
    expect(armThresholdMs({})).toBe(30_000);
    expect(armThresholdMs({ COLLIE_POLL_IDLE_MS: "12000" })).toBe(30_000);
  });

  test("a relaxed idle poll moves the threshold with it — that is the whole point", () => {
    // 2.5 × 60 s = 150 s. An operator who relaxed the poll to save a laptop's battery does not
    // discover months later that their idle pack arms its own door every night.
    expect(armThresholdMs({ COLLIE_POLL_IDLE_MS: "60000" })).toBe(150_000);
  });

  test("the floor holds a very tight poll back from a hair-trigger", () => {
    expect(armThresholdMs({ COLLIE_POLL_IDLE_MS: "500" })).toBe(ARM_FLOOR_MS);
  });

  test("a garbage idle poll falls back to the default rather than to zero", () => {
    for (const raw of ["", "  ", "0", "-1", "soon"]) {
      expect(armThresholdMs({ COLLIE_POLL_IDLE_MS: raw })).toBe(30_000);
    }
  });

  test("the operator's override wins, and one below the idle poll WARNS rather than being refused", () => {
    expect(armThresholdMs({ COLLIE_STANDBY_ARM_MS: "5000", COLLIE_POLL_IDLE_MS: "12000" })).toBe(5000);
    const warning = armThresholdWarning({ COLLIE_STANDBY_ARM_MS: "5000", COLLIE_POLL_IDLE_MS: "12000" });
    expect(warning).toContain("arm itself on an idle pack");
    // Above the idle poll there is nothing to say, and no override at all is silent.
    expect(armThresholdWarning({ COLLIE_STANDBY_ARM_MS: "30000", COLLIE_POLL_IDLE_MS: "12000" })).toBeNull();
    expect(armThresholdWarning({})).toBeNull();
  });
});

describe("the bind is absent-means-closed (RFC §6.2)", () => {
  test("no COLLIE_STANDBY_PORT means no door at all", () => {
    for (const env of [{}, { COLLIE_STANDBY_PORT: "" }, { COLLIE_STANDBY_PORT: "0" }, { COLLIE_STANDBY_PORT: "no" }]) {
      expect(standbyPortOf(env)).toBeNull();
    }
    expect(standbyPortOf({ COLLIE_STANDBY_PORT: "70000" })).toBeNull();
    expect(standbyPortOf({ COLLIE_STANDBY_PORT: "8788" })).toBe(8788);
  });

  test("the host defaults to loopback — the failover proxy is normally co-located", () => {
    expect(standbyHostOf({})).toBe("127.0.0.1");
    expect(standbyHostOf({ COLLIE_STANDBY_HOST: " 100.64.0.2 " })).toBe("100.64.0.2");
  });
});

describe("a verified warrant naming THIS machine (RFC §6.3, factor one)", () => {
  test("the ordinary case: a peer named by its own lead", () => {
    expect(warrantNamesSelf("peer", deputyStore(), T0)).toBe(true);
  });

  test("every clause refuses on its own", () => {
    // No warrant at all.
    expect(warrantNamesSelf("peer", peerStore(), T0)).toBe(false);
    // A warrant naming somebody else — this is the case `deputyAnchorOf` accepts, and this one must not.
    expect(warrantNamesSelf("peer", peerStore({ warrant: warrantFor("nas") }), T0)).toBe(false);
    // A revocation names nobody, so it arms nobody.
    const revoked = mintWarrant(
      { ...leadStore({ peers: [member({ memberId: "laptop" })] }), warrant: warrantFor("laptop") },
      null,
      T0,
    );
    expect(revoked).not.toBeNull();
    expect(warrantNamesSelf("peer", peerStore({ warrant: { warrant: revoked!.result, deputyCertPem: null } }), T0)).toBe(
      false,
    );
    // Past its 30 days on THIS machine's clock.
    expect(warrantNamesSelf("peer", deputyStore(), T0 + 31 * 24 * 60 * 60 * 1000)).toBe(false);
    // A signature that does not verify against the pinned lead's certificate.
    const bent = deputyStore();
    const forged = { ...bent.warrant!, warrant: { ...bent.warrant!.warrant, generation: 99 } };
    expect(warrantNamesSelf("peer", { ...bent, warrant: forged }, T0)).toBe(false);
    // A lead is never a deputy of itself, whatever its store says.
    expect(warrantNamesSelf("lead", deputyStore(), T0)).toBe(false);
    expect(warrantNamesSelf("solo", deputyStore(), T0)).toBe(false);
    // A store with no pack, and one whose lead is a tombstone.
    expect(warrantNamesSelf("peer", { ...deputyStore(), pack: null }, T0)).toBe(false);
    expect(
      warrantNamesSelf("peer", deputyStore({ lead: member({ memberId: "desk", role: "lead", status: "unenrolled" }) }), T0),
    ).toBe(false);
  });

  test("a warrant for ANOTHER pack, or from another lead, names nothing here", () => {
    const foreign = deputyStore();
    expect(warrantNamesSelf("peer", { ...foreign, pack: { ...foreign.pack!, packId: "pack-2" } }, T0)).toBe(false);
    expect(warrantNamesSelf("peer", deputyStore({ lead: member({ memberId: "attic", role: "lead" }) }), T0)).toBe(false);
  });
});

describe("the arming matrix — every factor, absent on its own (RFC §6.3)", () => {
  test("all three present: armed", () => {
    expect(isArmed(facts())).toBe(true);
  });

  test("no warrant: not armed, however quiet the lead is", () => {
    const report = armingReport(facts({ warrantsSelf: false, silentForMs: 10 * 60_000 }));
    expect(report).toEqual({ armed: false, hasWarrant: false, silentEnough: true, hasDevices: true });
  });

  test("not silent enough: not armed, and one millisecond decides it", () => {
    expect(isArmed(facts({ silentForMs: 29_999 }))).toBe(false);
    expect(isArmed(facts({ silentForMs: 30_000 }))).toBe(true);
  });

  test("an EMPTY synced registry refuses to arm — it does not arm ungated (RFC §6.4)", () => {
    const report = armingReport(facts({ deviceCount: 0 }));
    expect(report).toEqual({ armed: false, hasWarrant: true, silentEnough: true, hasDevices: false });
  });

  test("arming is reversible and instantaneous — the lead's next call disarms it", () => {
    const contact = new LeadContact(T0);
    // Never dialled, one full window after boot: silence is measured from the LATER of the two.
    expect(silenceOf(contact.facts(), T0 + 29_999)).toBe(29_999);
    expect(isArmed(facts({ silentForMs: silenceOf(contact.facts(), T0 + 40_000) }))).toBe(true);
    contact.record(T0 + 40_000);
    expect(isArmed(facts({ silentForMs: silenceOf(contact.facts(), T0 + 40_001) }))).toBe(false);
  });

  test("a reboot does not arm the door instantly — processStartedAt is in the max on purpose", () => {
    const contact = new LeadContact(T0 + 1_000_000);
    contact.record(T0); // an ancient receipt, from before this process existed
    expect(silenceOf(contact.facts(), T0 + 1_000_000)).toBe(0);
  });
});

describe("the page", () => {
  test("every interpolation is escaped, without exception", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;",
    );
    const page = standbyPage(facts({ packName: `<img src=x onerror=alert(1)>` }));
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x");
  });

  test("ARMED: one sentence, one button, and it names the silence", () => {
    const page = standbyPage(facts({ silentForMs: 47_000 }));
    expect(page).toContain("Take over");
    expect(page).toContain("Your lead <code>desk</code> has not called this machine for 47 seconds.");
    expect(page).toContain("This machine (<code>laptop</code>) is the deputy");
    expect(page).toContain(`<button id="go" type="button">Take over</button>`);
    // The confirm needs the pairing credential out of localStorage, and nothing else runs here.
    expect(page).toContain("collie:device-token");
    expect(page).not.toContain("http://");
  });

  test("ARMED with witnesses: it says who will be asked before anything changes", () => {
    expect(standbyPage(facts({ witnessCount: 2 }))).toContain("ask 2 other machines whether it has called");
    expect(standbyPage(facts({ witnessCount: 1 }))).toContain("ask 1 other machine whether it has called");
  });

  test("TWO-MACHINE pack: the page says the quiet part above the button (RFC §16, decision 8)", () => {
    const page = standbyPage(facts({ witnessCount: 0 }));
    expect(page).toContain("There are no other machines to ask. If your lead is up and you simply cannot");
    expect(page).toContain("reach it, taking over will split your pack.");
    // Allowed anyway — refusing a two-machine pack would refuse the feature.
    expect(page).toContain(`<button id="go"`);
  });

  test("COLD: a statement of fact with NO action on it at all", () => {
    const page = standbyPage(facts({ silentForMs: 3000 }));
    expect(page).toContain("Standby");
    expect(page).not.toContain("<button");
    expect(page).not.toContain("<script");
    expect(page).toContain("called this machine 3 seconds ago; it is alive");
  });

  test("COLD names the factor the operator can act on, in their order of usefulness", () => {
    expect(coldReason(facts({ warrantsSelf: false }), armingReport(facts({ warrantsSelf: false })))).toContain(
      "collie pack deputy",
    );
    expect(coldReason(facts({ deviceCount: 0 }), armingReport(facts({ deviceCount: 0 })))).toContain("collie pair");
  });

  test("the CSP admits the one inline script by hash, and nothing else", () => {
    const csp = standbyCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain("unsafe-inline'; script");
    expect(csp).toContain("frame-ancestors 'none'");
    // Stable across calls: the hash is over the script's own bytes.
    expect(standbyCsp()).toBe(csp);
  });

  test("durations read the way a person reads them", () => {
    expect(humanSilence(0)).toBe("0 seconds");
    expect(humanSilence(1000)).toBe("1 second");
    expect(humanSilence(47_000)).toBe("47 seconds");
    expect(humanSilence(600_000)).toBe("10 minutes");
    expect(humanSilence(3 * 3600_000)).toBe("3 hours");
  });
});

describe("the door's three routes", () => {
  const req = (path: string, init: RequestInit = {}) =>
    new Request(`http://deputy.internal:8788${path}`, init);

  function door(over: Partial<StandbyFacts> = {}, takeover = async () => ({ ok: true, message: "done" })) {
    const calls: string[] = [];
    const handler = createStandbyDoor({
      version: "1.4.0+abc1234",
      build: () => Promise.resolve("b-2026-09-03"),
      facts: () => facts(over),
      devices: () => (over.deviceCount === 0 ? [] : [DEVICE]),
      takeover: async (device) => {
        calls.push(device);
        return takeover();
      },
    });
    return { handler, calls };
  }

  test("health: 503 cold, 200 armed — the two answers a failover proxy switches on (RFC §14.2)", async () => {
    const cold = await door({ silentForMs: 1000 }).handler(req(STANDBY_HEALTH_PATH), new URL(`http://x${STANDBY_HEALTH_PATH}`));
    expect(cold!.status).toBe(503);
    expect(await cold!.json()).toEqual({ state: "cold", version: "1.4.0+abc1234", build: "b-2026-09-03" });

    const armed = await door().handler(req(STANDBY_HEALTH_PATH), new URL(`http://x${STANDBY_HEALTH_PATH}`));
    expect(armed!.status).toBe(200);
    expect(await armed!.json()).toEqual({
      state: "armed",
      silentForMs: 60_000,
      version: "1.4.0+abc1234",
      build: "b-2026-09-03",
    });
  });

  test("health never names a member — a stranger who reaches the port learns nothing", async () => {
    for (const over of [{}, { silentForMs: 1000 }]) {
      const res = await door(over).handler(req(STANDBY_HEALTH_PATH), new URL(`http://x${STANDBY_HEALTH_PATH}`));
      const body = await res!.text();
      expect(body).not.toContain("laptop");
      expect(body).not.toContain("desk");
      expect(body).not.toContain("the herd");
    }
  });

  test("the page is served in BOTH states, so the door can be confirmed before the bad day", async () => {
    for (const over of [{}, { silentForMs: 1000 }]) {
      const res = await door(over).handler(req(STANDBY_PATH), new URL(`http://x${STANDBY_PATH}`));
      expect(res!.status).toBe(200);
      expect(res!.headers.get("content-type")).toContain("text/html");
      expect(res!.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res!.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("COLD: the confirm is 409 with the reason, and the credential is never even consulted", async () => {
    const d = door({ silentForMs: 1000 });
    const res = await d.handler(
      req(STANDBY_TAKEOVER_PATH, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
      new URL(`http://x${STANDBY_TAKEOVER_PATH}`),
    );
    expect(res!.status).toBe(409);
    expect(await res!.json()).toMatchObject({ ok: false });
    expect(d.calls).toEqual([]);
  });

  test("the auth matrix: pairing bearer ONLY, and a device header does NOT count (RFC §16, decision 2)", async () => {
    const good = door();
    const ok = await good.handler(
      req(STANDBY_TAKEOVER_PATH, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
      new URL(`http://x${STANDBY_TAKEOVER_PATH}`),
    );
    expect(ok!.status).toBe(200);
    expect(good.calls).toEqual(["phone"]);

    const rejected: Record<string, string>[] = [
      {},
      { authorization: "Bearer not-the-token" },
      { authorization: "Bearer " },
      { authorization: TOKEN },
      // THE NARROWING, PINNED: the header gate composes by AND on `/api/*` and is not applied here.
      // A device header the (broken) proxy would have injected admits nothing on its own.
      { "x-tailnet-device": "phone" },
      { "x-collie-device": "phone" },
    ];
    for (const headers of rejected) {
      const d = door();
      const res = await d.handler(
        req(STANDBY_TAKEOVER_PATH, { method: "POST", headers }),
        new URL(`http://x${STANDBY_TAKEOVER_PATH}`),
      );
      expect(res!.status).toBe(401);
      expect(d.calls).toEqual([]);
    }
  });

  test("a takeover that REFUSES is a 409 with the sentence, never a 5xx", async () => {
    const d = door({}, async () => ({ ok: false, message: "your lead answered 0.4 s ago; it is alive." }));
    const res = await d.handler(
      req(STANDBY_TAKEOVER_PATH, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
      new URL(`http://x${STANDBY_TAKEOVER_PATH}`),
    );
    expect(res!.status).toBe(409);
    expect(await res!.json()).toEqual({ ok: false, message: "your lead answered 0.4 s ago; it is alive." });
  });

  test("nothing else is served — three routes, and every other path is not this door's", async () => {
    const d = door();
    for (const path of ["/", "/api/snapshot", "/pack/v1/hello", "/standby/", "/standbyx", "/index.html"]) {
      expect(await d.handler(req(path), new URL(`http://x${path}`))).toBeNull();
    }
  });

  test("the wrong method on an owned route is 405, never a fallthrough", async () => {
    const d = door();
    const post = await d.handler(req(STANDBY_PATH, { method: "POST" }), new URL(`http://x${STANDBY_PATH}`));
    expect(post!.status).toBe(405);
    const get = await d.handler(req(STANDBY_TAKEOVER_PATH), new URL(`http://x${STANDBY_TAKEOVER_PATH}`));
    expect(get!.status).toBe(405);
  });
});

describe("the front door's own health answer (RFC §14.2)", () => {
  test("a LEAD answers 200 while it leads", async () => {
    const res = frontDoorHealth("lead", new URL(`http://desk${STANDBY_HEALTH_PATH}`));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ state: "leading" });
  });

  test("a peer and a solo instance answer NOTHING — no route is gained (§11)", () => {
    expect(frontDoorHealth("peer", new URL(`http://x${STANDBY_HEALTH_PATH}`))).toBeNull();
    expect(frontDoorHealth("solo", new URL(`http://x${STANDBY_HEALTH_PATH}`))).toBeNull();
    expect(frontDoorHealth("lead", new URL("http://x/api/snapshot"))).toBeNull();
  });
});

test("the fixtures really are the material the store would hold", () => {
  // A guard on this file rather than on the code: every clause above compares a fingerprint derived
  // from a certificate, so a placeholder fixture would make the whole suite vacuous.
  expect(warrantFor("laptop").warrant.deputyFingerprint).toBe(fp("laptop"));
});

// ── The version stamp on the standby port (M15/05) ──────────────────────────────────────────────
//
// The detached updater's health gate asks "which build came back?" after a restart. On a LEAD it
// asks `/api/health`; on a PEER that pins its lead it cannot — the main port is behind mutual TLS
// there, and a wide-bound instance is not on loopback either. The standby listener is plain HTTP on
// its own address in every one of those states, so the answer rides EVERY response it makes.
describe("standby answers the version", () => {
  const req = (path: string, init: RequestInit = {}) =>
    new Request(`http://deputy.internal:8788${path}`, init);
  const url = (path: string) => new URL(`http://deputy.internal:8788${path}`);
  const VERSION = "1.4.0+abc1234";

  const handler = createStandbyDoor({
    version: VERSION,
    build: () => Promise.resolve("b-2026-09-03"),
    facts: () => facts({}),
    devices: () => [DEVICE],
    takeover: async () => ({ ok: true, message: "done" }),
  });

  test("every response from the listener carries X-Collie-Version, whatever it answers", async () => {
    // The stamp is applied at the LISTENER, so the set it covers is "every answer this port makes" —
    // the door's own routes, `/standby/update`, and the bare 404 for a path nobody owns.
    const answers = [
      await handler(req(STANDBY_HEALTH_PATH), url(STANDBY_HEALTH_PATH)),
      await handler(req(STANDBY_PATH), url(STANDBY_PATH)),
      await handler(req(STANDBY_TAKEOVER_PATH, { method: "GET" }), url(STANDBY_TAKEOVER_PATH)),
      standbyUpdateAnswer(req(STANDBY_UPDATE_PATH), url(STANDBY_UPDATE_PATH), () => null),
      new Response("not found", { status: 404 }),
    ];
    for (const answer of answers) {
      expect(answer).not.toBeNull();
      const stamped = withStandbyVersion(answer!, VERSION);
      expect(stamped.headers.get(STANDBY_VERSION_HEADER)).toBe(VERSION);
    }
  });

  test("the header carries the VERSION, which is what the health gate compares", () => {
    // Not the web bundle's id — that is what the FRONT door's header of the same name carries. Two
    // ports, two questions, and `/standby/health`'s body carries both facts under their own names.
    const stamped = withStandbyVersion(new Response("x"), VERSION);
    expect(stamped.headers.get(STANDBY_VERSION_HEADER)).toMatch(/^\d+\.\d+\.\d+\+/);
  });

  test("a COLD door still says what it is running — a 503 is 'do not route here', not silence", async () => {
    const cold = await createStandbyDoor({
      version: VERSION,
      build: () => Promise.resolve("b-2026-09-03"),
      facts: () => facts({ silentForMs: 1000 }),
      devices: () => [DEVICE],
      takeover: async () => ({ ok: true, message: "done" }),
    })(req(STANDBY_HEALTH_PATH), url(STANDBY_HEALTH_PATH));
    expect(cold!.status).toBe(503);
    expect(await cold!.json()).toMatchObject({ version: VERSION, build: "b-2026-09-03" });
  });
});
