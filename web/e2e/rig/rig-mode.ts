// `rig.ts` picks the crew rig from its own command line: `up --crew`, `down --crew`, `status --crew`,
// `start pi --on member --crew`, and every `crew <verb>`. rig-lib.ts reads COLLIE_RIG_CREW when it is
// first imported, so this file must be the FIRST import of rig.ts. The daemon it spawns inherits it.
const args = process.argv.slice(2);
if (args.includes("--crew") || args[0] === "crew") process.env.COLLIE_RIG_CREW = "1";
