// THE DEPUTY'S TWO COPIES AROUND THE TAKEOVER (CREW_PROTOCOL §25).
//
// The copies of the lead's tricks (standby-tricks.ts) and of its open Decisions (standby-hill.ts) are
// removed once this machine is not its lead's deputy any more, and the takeover commit itself makes it
// the lead. So the commit holds both copies until the tap has done with them.

/** A copy the commit holds. */
export interface HeldCopy {
  hold(): () => void;
}

/** Hold every copy at once. The one release lets go of all of them, once. */
export function holdCopies(copies: readonly (HeldCopy | null)[]): () => void {
  const releases = copies.flatMap((copy) => (copy === null ? [] : [copy.hold()]));
  return () => {
    for (const release of releases) release();
  };
}
