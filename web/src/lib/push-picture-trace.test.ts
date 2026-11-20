import { afterEach, describe, expect, it, vi } from "vitest";

import { keepPushPictureTrace, type TraceCaches } from "./project-picture-push";
import { __resetPushPictureTrace, reportPushPictureTrace } from "./push-picture-trace";

// THE PUSH PICTURE TRACE, THE PAGE'S HALF (round 19): the worker's last verdict, posted once per page life
// with the page's own build, and never twice.

function traceCaches(): TraceCaches {
  const store = new Map<string, Response>();
  return {
    open: async () => ({
      match: async (key: RequestInfo | URL) => store.get(String(key))?.clone(),
      put: async (key: RequestInfo | URL, res: Response) => void store.set(String(key), res),
      delete: async (key: RequestInfo | URL) => store.delete(String(key)),
    }),
  };
}

const AT = 1_700_000_000_000;
const WORKER = "1.29.1-dev+0072de30c4.1795163609";
const PAGE = "1.29.1-dev+d794485c15.1795170000";

afterEach(() => __resetPushPictureTrace());

describe("reportPushPictureTrace", () => {
  it("posts the worker's verdict, its age and both builds, once per page life", async () => {
    const caches = traceCaches();
    await keepPushPictureTrace(caches, location.origin, "/", { verdict: "no-copy", machine: "member", at: AT, workerBuild: WORKER });
    const post = vi.fn(async () => {});
    await reportPushPictureTrace({ caches, post, now: () => AT + 125_400, pageBuild: PAGE });
    expect(post).toHaveBeenCalledWith({ verdict: "no-copy", machine: "member", ageS: 125, workerBuild: WORKER, pageBuild: PAGE });
    await keepPushPictureTrace(caches, location.origin, "/", { verdict: "shown", machine: "lead", at: AT, workerBuild: WORKER });
    await reportPushPictureTrace({ caches, post, now: () => AT, pageBuild: PAGE });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("posts nothing when the worker kept no verdict, and the next page life does not post an old one", async () => {
    const caches = traceCaches();
    const post = vi.fn(async () => {});
    await reportPushPictureTrace({ caches, post, now: () => AT, pageBuild: PAGE });
    expect(post).not.toHaveBeenCalled();
    await keepPushPictureTrace(caches, location.origin, "/", { verdict: "shown", machine: "lead", at: AT, workerBuild: WORKER });
    __resetPushPictureTrace();
    await reportPushPictureTrace({ caches, post, now: () => AT, pageBuild: PAGE });
    __resetPushPictureTrace();
    await reportPushPictureTrace({ caches, post, now: () => AT, pageBuild: PAGE });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does nothing where there is no Cache Storage", async () => {
    const post = vi.fn(async () => {});
    await reportPushPictureTrace({ caches: undefined, post, now: () => AT, pageBuild: PAGE });
    expect(post).not.toHaveBeenCalled();
  });
});
