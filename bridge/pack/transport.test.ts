import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { leadStore, material, member, peerStore } from "./fixtures.ts";
import { dialTls, peerListenerTls } from "./transport.ts";

describe("the peer's pinned listener", () => {
  test("a peer anchors on its lead's certificate, and demands one back", () => {
    const store = peerStore();
    const tls = peerListenerTls("peer", store);
    expect(tls).not.toBeNull();
    expect(tls!.cert).toBe(store.self.certPem);
    expect(tls!.key).toBe(store.self.keyPem);
    // EXACTLY ONE anchor — a peer has no peers (§4), so anything else in this list would be a
    // machine that could reach this pane family without being anyone's lead.
    expect(tls!.ca).toEqual([store.lead!.certPem]);
    expect(tls!.requestCert).toBe(true);
    expect(tls!.rejectUnauthorized).toBe(true);
  });

  test("a lead pins nothing: its surface rides a front door that terminates TLS", () => {
    expect(peerListenerTls("lead", leadStore({ peers: [member({ memberId: "laptop" })] }))).toBeNull();
  });

  test("a solo instance has no listener TLS and no store to build it from", () => {
    expect(peerListenerTls("solo", null)).toBeNull();
    expect(peerListenerTls("peer", null)).toBeNull();
  });

  test("a peer whose lead is unenrolled or certificate-less pins NOTHING, and so admits nothing", () => {
    // Fail-closed, and the reason it is expressed as `null` rather than as a relaxed listener: the
    // caller turns `null` into `transportPinned: false`, and admission then refuses every request.
    // A listener built without `ca` would have been a pack running on the secret alone.
    expect(peerListenerTls("peer", peerStore({ lead: member({ memberId: "desk", role: "lead", status: "unenrolled" }) }))).toBeNull();
    expect(peerListenerTls("peer", peerStore({ lead: member({ memberId: "desk", role: "lead", certPem: "" }) }))).toBeNull();
    expect(peerListenerTls("peer", peerStore({ lead: null }))).toBeNull();
  });

  test("a membership change re-pins ONLY through a restart — there is no live reload path", () => {
    // `server.reload({ tls })` does NOT swap a pinned `ca` on Bun 1.3.14 (measured; a member added
    // after bind is still refused at the handshake). So the listener's anchors are a pure function of
    // the trust store AS IT WAS AT BOOT, and the only thing that changes them is a new process —
    // which is exactly why every membership verb restarts the bridge (`applyLocally`, cli/pack.ts).
    const before = peerListenerTls("peer", peerStore());
    const rotated = peerStore({ lead: member({ memberId: "nas", role: "lead" }) });
    const after = peerListenerTls("peer", rotated);
    expect(after!.ca).toEqual([material("nas").certPem]);
    expect(after!.ca).not.toEqual(before!.ca);

    // The structural half of the same claim: nothing in the bridge calls `reload`, so no code path
    // could believe it re-pinned. A grep, because the alternative is a live server.
    for (const file of ["server.ts", "index.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(src).not.toMatch(/\.reload\(/);
    }
  });
});

describe("the dialling side", () => {
  test("it pins the member's certificate and drops the NAME check", () => {
    const store = leadStore({ peers: [member({ memberId: "laptop" })] });
    const tls = dialTls(store, store.peers[0]!);
    expect(tls).not.toBeNull();
    expect(tls!.ca).toEqual([material("laptop").certPem]);
    expect(tls!.rejectUnauthorized).toBe(true);
    // §4: an address is a hint the operator may re-point, so a member that roams must not become
    // untrusted because its SAN no longer covers where it is dialled. Identity is the certificate.
    expect(tls!.checkServerIdentity).toBeInstanceOf(Function);
    expect(tls!.checkServerIdentity!()).toBeUndefined();
  });

  test("it presents THIS collie's own certificate, so the far side can pin back", () => {
    const store = leadStore({ peers: [member({ memberId: "laptop" })] });
    const tls = dialTls(store, store.peers[0]!);
    expect(tls!.cert).toBe(store.self.certPem);
    expect(tls!.key).toBe(store.self.keyPem);
  });

  test("a member with no certificate is not dialled unpinned — it is not dialled", () => {
    expect(dialTls(leadStore(), { certPem: "" })).toBeNull();
    expect(dialTls(null, { certPem: material("laptop").certPem })).toBeNull();
  });
});
