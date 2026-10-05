import { readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

// THE SHELL'S REAL CONTENT-SECURITY-POLICY, FOR THE `app` TARGET.
//
// The `app` target serves `web/dist` with `vite preview`, which sends no CSP at all. The real bridge
// sends one on every HTML document it serves (`bridge/server.ts`, the `CSP` constant), and a few
// features only mean what they mean under it: the Files view's HTML preview is a `srcdoc` frame,
// and a srcdoc document INHERITS the embedding page's policy. A case that proves that frame is
// sandboxed and offline has to run with the same header.
//
// The policy is never re-typed here. It is read out of the bridge's source at test time, so a change
// to the policy there reaches this case, and a refactor that moves the constant fails this loudly
// (the throw below) instead of quietly testing a page with no policy.

/** The policy string the bridge sends, read from `bridge/server.ts`. */
export function shellCsp(): string {
  const source = readFileSync(new URL("../../../bridge/server.ts", import.meta.url), "utf8");
  const declaration = /const CSP =\s*((?:"[^"\n]*"\s*\+?\s*)+);/.exec(source);
  if (declaration === null) throw new Error("bridge/server.ts no longer declares `const CSP = \"…\" + \"…\";`");
  const policy = [...declaration[1]!.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]).join("");
  if (!policy.includes("default-src 'self'")) throw new Error(`the shell CSP read from the bridge looks wrong: ${policy}`);
  return policy;
}

/**
 * Answer every document request of `page` with the shell's CSP header added, as the bridge does.
 * Register it AFTER `installApiStub`: a later route runs first, hands anything that is not a
 * document on (`fallback`), and the stub still answers the API.
 */
export async function serveWithShellCsp(page: Page): Promise<string> {
  const policy = shellCsp();
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy } });
  });
  return policy;
}
