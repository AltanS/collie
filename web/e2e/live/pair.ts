// Tier 2's one credential. Reads need the pairing token since ADR 0086, so a plain browser on the
// dev lane now sees "Pair this device" and nothing these cases assert. This global setup makes sure
// the run holds a token before the first case, and it is the only thing in this directory that may
// call `POST /api/pair`.
//
// TWO WAYS IN, AND NEITHER IS AUTOMATIC. A pairing code exists only on the operator's own terminal,
// so a person is in the loop either way:
//
//   1. `COLLIE_E2E_DEVICE_TOKEN` holds a token from an earlier run. It is used as it is.
//   2. `COLLIE_E2E_PAIR_CODE` holds a code `collie pair` printed on the dev lane in the last ten
//      minutes. The setup claims it once as the device `e2e-live`, prints the export line for the
//      next run, and the token then lives in this process's environment only. Nothing is written to
//      disk.
//
// With neither, the run stops here with the remedy. A hard throw, not a skip: a skipped suite
// reports green, and every case would otherwise fail one by one on a pair card.
import type { FullConfig } from "@playwright/test";

/** The variable a case reads the token from (live.ts). */
export const TOKEN_ENV = "COLLIE_E2E_DEVICE_TOKEN";
const CODE_ENV = "COLLIE_E2E_PAIR_CODE";
/** The label the run pairs as, so `collie devices list` names it and `collie devices revoke` can. */
const LABEL = "e2e-live";

export default async function pair(config: FullConfig): Promise<void> {
  if ((process.env[TOKEN_ENV] ?? "") !== "") return;
  const code = process.env[CODE_ENV] ?? "";
  const baseURL = config.projects[0]?.use.baseURL;
  if (code === "" || baseURL === undefined) {
    throw new Error(
      `Tier 2 needs a paired device: reads need the pairing token (ADR 0086). Run \`collie pair\` ` +
        `on the dev lane and pass the code as ${CODE_ENV}, or pass an earlier token as ${TOKEN_ENV}.`,
    );
  }
  // Same-origin, like the app's own pair form: the route's write gate demands a matching Origin.
  const origin = new URL(baseURL).origin;
  const res = await fetch(new URL("/api/pair", baseURL), {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify({ code, label: LABEL }),
  });
  // The bridge's own answer shape (`{ token, label }`, bridge/server.ts `/api/pair`).
  const body: { token?: string } = await res.json().catch(() => ({}));
  const token = body.token ?? "";
  if (!res.ok || token === "") {
    throw new Error(`POST /api/pair answered ${String(res.status)}: the code is wrong, used or expired.`);
  }
  process.env[TOKEN_ENV] = token;
  // The one place the token is shown: on the operator's own terminal, so the next run can skip the
  // code. `collie devices revoke e2e-live` retires it.
  console.log(`\nPaired as "${LABEL}". For the next run:\n  export ${TOKEN_ENV}=${token}\n`);
}
