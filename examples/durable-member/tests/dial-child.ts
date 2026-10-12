// A process that dials the socket and says what it got. The descendant tests start it as a child, a grandchild
// and an orphan of the program. Settings come from the environment: DM_SOCK, DM_PATH, DM_METHOD, DM_BODY, DM_OUT.
import { writeFileSync } from "node:fs";
import { call } from "./client.ts";

const method = process.env.DM_METHOD ?? "GET";
const body = process.env.DM_BODY ? JSON.parse(process.env.DM_BODY) : undefined;
const r = await call({ socket: process.env.DM_SOCK!, version: 1 }, method, process.env.DM_PATH!, body);
const line = JSON.stringify({ status: r.status, code: r.body?.code });
if (process.env.DM_OUT) writeFileSync(process.env.DM_OUT, line);
else console.log(line);
