// `rig.ts` picks the crew rig from its own command line: `up --crew`, `down --crew`, `status --crew`,
// `start pi --on member --crew`, and every `crew <verb>`. rig-lib.ts reads COLLIE_RIG_CREW when it is
// first imported, so this file must be the FIRST import of rig.ts. The daemon it spawns inherits it.
// splitArgs reads `--crew` only where the rig reads it: a `--crew` inside a pane's command stays there.
import { splitArgs } from "./rig-scope";

const split = splitArgs(process.argv.slice(2));
if (split.crew || split.verb === "crew") process.env.COLLIE_RIG_CREW = "1";
