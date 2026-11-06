// Which pin session a pane is on, as the snapshot's badge needs it (M90).
//
// The pins route resolves a pane's session with `journalRefOf`, which is async: a harness that corrects a
// stale reported ref (`reconcile`) or finds its own session (`discover`) reads a file or the screen. The
// snapshot is synchronous and polled, so it cannot ask. This cache closes the gap with ONE key function,
// the route's: the route and a background refresh both run the same resolver and store its key here, and
// the snapshot only reads what they stored. The one shortcut is a pane whose reported ref the route would
// use as it stands (an adapter with no `reconcile`): its key is derived at once from that ref, which is
// what `journalRefOf` answers for it.
//
// An entry belongs to a pane INSTANCE and its inputs. The fingerprint is the walky instance token (a
// reused pane id is a new session), the agent, the folder and the reported ref; when any of them moves
// the entry is dropped and the badge reads zero until the new key lands, never the old session's count.
// A key the route cannot settle from the fingerprint alone (a discovered or reconciled one) is asked
// again once it is {@link PIN_KEY_TTL_MS} old, and keeps its old value until the answer comes: a `/clear`
// that starts another session in the same pane shows the new session's count within that time.

/** How long a resolved key stands before the snapshot asks again, for a key only the resolver can settle. */
export const PIN_KEY_TTL_MS = 30_000;

interface Entry {
  readonly fingerprint: string;
  key: string | null;
  at: number;
  asking: boolean;
}

export class PinKeys {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = PIN_KEY_TTL_MS,
  ) {}

  /**
   * The key for a pane, or null while none is known. `derived` is the key the pane's reported ref gives when
   * the route would use that ref unchanged, or undefined when only `resolve` can tell. `resolve` is the
   * route's own resolver; it runs in the background and never throws into the snapshot.
   */
  keyOf(paneKey: string, fingerprint: string, derived: string | undefined, resolve: () => Promise<string | null>): string | null {
    const held = this.entries.get(paneKey);
    if (held !== undefined && held.fingerprint !== fingerprint) this.entries.delete(paneKey);
    const entry = this.entries.get(paneKey);
    if (derived !== undefined) {
      this.entries.set(paneKey, { fingerprint, key: derived, at: this.now(), asking: false });
      return derived;
    }
    if (entry === undefined) return this.ask(paneKey, fingerprint, undefined, resolve);
    if (this.now() - entry.at >= this.ttlMs) this.ask(paneKey, fingerprint, entry, resolve);
    return entry.key;
  }

  /** The route resolved this pane's session: store what it used, so the badge and the list name one session. */
  remember(paneKey: string, fingerprint: string, key: string | null): void {
    this.entries.set(paneKey, { fingerprint, key, at: this.now(), asking: false });
  }

  private ask(paneKey: string, fingerprint: string, entry: Entry | undefined, resolve: () => Promise<string | null>): string | null {
    if (entry?.asking === true) return entry.key;
    const slot: Entry = entry ?? { fingerprint, key: null, at: this.now(), asking: false };
    slot.asking = true;
    this.entries.set(paneKey, slot);
    void resolve().then(
      (key) => this.settle(paneKey, fingerprint, key),
      // A resolver that threw has not said the session is gone: the old key stands until the next ask.
      () => this.settle(paneKey, fingerprint, this.entries.get(paneKey)?.key ?? null),
    );
    return slot.key;
  }

  private settle(paneKey: string, fingerprint: string, key: string | null): void {
    // The pane moved on while the question was out: the answer is for a session it no longer runs.
    if (this.entries.get(paneKey)?.fingerprint !== fingerprint) return;
    this.remember(paneKey, fingerprint, key);
  }
}
