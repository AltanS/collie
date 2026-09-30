import { afterAll, afterEach, beforeAll } from "vitest";
import { setupServer } from "msw/node";

import { handlers, resetTypedDraft } from "./handlers";

// The MSW server, and NOTHING that needs a document.
//
// ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────────────
// `setup.ts` is the jsdom project's setup and does two jobs: it stands up this server, and it patches
// a document (jest-dom matchers, `Element.prototype.scrollIntoView`, `window.matchMedia`, a
// `localStorage` clear). The second job is what made the whole file unusable under
// `environment: "node"`, and two pure-logic tests in `src/lib/harness/omp/` import `server` from it
// purely to add a handler.
//
// That single import was enough to keep them out of the fast project, and a project with two named
// exceptions is a project whose exception list rots. So the server moved here, `setup.ts` re-exports
// it, and `src/lib/harness/**` is now uniformly node-safe with no exceptions at all. `msw/node` is
// the node adapter; running it outside jsdom is its native case, not a workaround.
export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => {
  server.resetHandlers();
  resetTypedDraft(); // the fake pane's input line, so a draft can't leak into the next test
});
afterAll(() => server.close());
