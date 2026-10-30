// M77: the crew's members grouped under the machine they run on, for the plain-text views.
//
// A member is one Collie instance; two can share a host (the Herdr TUI and the Herdr core). `collie
// status` and `collie crew status` print one host line with the instances under it, but ONLY when some
// host carries two instances. A crew where every host holds one prints exactly the flat list it always
// did, so a one-instance crew stays as short as it was. A member that did not name its host is a group
// of its own, keyed by its id (the same rule as web/src/lib/machines.ts). `--json` never reads this.

export interface HostGroup<T> {
  /** The host the members share, or the id of a member that reported none. */
  readonly host: string;
  readonly members: readonly T[];
}

export interface HostGrouping<T> {
  /** True when some host holds more than one member: the one case the views print host lines. */
  readonly shared: boolean;
  /** Groups in the order their first member appears; members keep their given order inside a group. */
  readonly groups: readonly HostGroup<T>[];
}

export function groupMembersByHost<T>(
  members: readonly T[],
  keys: { readonly idOf: (m: T) => string; readonly hostOf: (m: T) => string | null },
): HostGrouping<T> {
  const byHost = new Map<string, T[]>();
  for (const m of members) {
    const host = keys.hostOf(m) ?? keys.idOf(m);
    const held = byHost.get(host);
    if (held === undefined) byHost.set(host, [m]);
    else held.push(m);
  }
  const groups = [...byHost].map(([host, held]): HostGroup<T> => ({ host, members: held }));
  return { shared: groups.some((g) => g.members.length > 1), groups };
}
