// Fire a one-off Web Push to every subscribed device — the manual counterpart to the automatic
// blocked/done notifications, so you can verify push end-to-end WITHOUT waiting for an agent to
// actually block.
//
// The behaviour lives in `cli/push.ts` (it is the `collie push-test` verb); this file is the
// from-source entry point kept for `scripts/collie-ctl.sh push-test` and for running it straight out
// of a checkout with no compiled binary. Prefer:
//
//   herdr plugin action invoke push-test --plugin herdr.collie
//   collie push-test ["title"] ["body"] ["paneId"]
import { loadContext } from "../cli/context.ts";
import { realIo } from "../cli/io.ts";
import { cmdPushTest } from "../cli/push.ts";
import { realFiles } from "../cli/sys.ts";

const ctx = loadContext(realIo.err);
process.exitCode = await cmdPushTest({ ctx, io: realIo, files: realFiles }, process.argv.slice(2));
