// THE PUSH PICTURE TRACE, THE PAGE'S HALF (round 19). The worker keeps the verdict of its last push about
// a pane (lib/project-picture-push.ts); the page takes it out once per page life and posts it with its own
// build, so the bridge's log can say which worker and which page a phone ran when a push came without its
// picture. No setting and nothing on screen.

import { postPushPictureDiag } from "@/lib/api";
import { basePath } from "@/lib/base-path";
import { BUILD } from "@/lib/build";
import { isBuildId, takePushPictureTrace, type PushPictureReport, type TraceCaches } from "@/lib/project-picture-push";

/** The oldest verdict worth reporting: thirty days, in seconds, the bridge's own bound. */
const MAX_AGE_S = 30 * 24 * 60 * 60;

let reported = false;

/** What the report needs, so a test can give its own. */
export interface TraceDeps {
  readonly caches: TraceCaches | undefined;
  readonly post: (report: PushPictureReport) => Promise<void>;
  readonly now: () => number;
  readonly pageBuild: string;
}

const browser = (): TraceDeps => ({ caches: globalThis.caches, post: postPushPictureDiag, now: Date.now, pageBuild: BUILD.id });

/** Post the worker's last verdict, once per page life. Never throws. */
export async function reportPushPictureTrace(deps: TraceDeps = browser()): Promise<void> {
  if (reported || deps.caches === undefined) return;
  reported = true;
  const trace = await takePushPictureTrace(deps.caches, location.origin, basePath());
  if (trace === null) return;
  const ageS = Math.min(MAX_AGE_S, Math.max(0, Math.round((deps.now() - trace.at) / 1000)));
  await deps.post({ verdict: trace.verdict, machine: trace.machine, ageS, workerBuild: trace.workerBuild, pageBuild: isBuildId(deps.pageBuild) ? deps.pageBuild : "unknown" });
}

/** Test seam: a new page life. */
export function __resetPushPictureTrace(): void {
  reported = false;
}
