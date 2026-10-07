// A scope written into server HTML as two attributes (`data-a-host`, `data-a-session`), read back.
import { internScope, type Scope } from "@web/lib/scope";

export function parseScope(host: string | undefined, session: string | undefined): Scope {
  return internScope({ host: host === "" ? undefined : host, session: session === "" ? undefined : session });
}
