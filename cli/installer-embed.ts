// Collie's own installer, embedded in the binary at build time.
//
// WHY EMBEDDED, AND NOT FETCHED. `crew add` on a lead that has no commit installs the member from
// the release the lead itself runs (#248), and the script that lays a release down is this one. It
// travels over the ssh the operator already authenticated, as a payload on the leg's own stdin —
// never `curl … | sh` on the far machine, which would be a second door into that host and a second
// thing to trust. The same reason `cli/docs-embed.ts` embeds the docs: a disk read needs a checkout
// root, and the install kinds that take this route are exactly the ones that may not have one.
//
// It is therefore a COMPILE-TIME SNAPSHOT of `scripts/install.sh`, and `cli/installer-embed.test.ts`
// fails when the two drift, so a stale copy cannot ship.
import installSh from "../scripts/install.sh" with { type: "text" };

/** `scripts/install.sh`, verbatim. The payload of the release install leg (`cli/remote.ts`). */
export const INSTALLER_SH: string = installSh;
