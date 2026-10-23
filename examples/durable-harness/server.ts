// The desk as a Node server: `node --import ./tests/node/register.mjs server.ts` (see the README for why the flag).
// Three routes:
//   /api/chat                              durable-harness's own chat route (a person or a script talks to the agent)
//   /.well-known/durable-harness/v1/flow   durable-harness's queue route (the shape a Vercel deploy needs; world-local does not call it)
//   /collie/session/v1/*                   Collie's route: attach it with `collie durable attach desk --url <base>/collie ...`
// COLLIE_TOKEN has no default. The server refuses to start without one of 32 bytes or more.
import "./lib/env.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getWorld, flowHandler } from "durable-harness";
import { chatRoute } from "durable-harness/pi-durable";
import { collieRoute, TOKEN_MIN_BYTES, tokenAccepted } from "../../packages/durable-sdk/src/durable-harness/index.ts";
import { INSTRUCTIONS, MODEL, NAME, open } from "./lib/pi.ts";

const token = process.env.COLLIE_TOKEN;
if (token === undefined || new TextEncoder().encode(token).byteLength < TOKEN_MIN_BYTES) {
  console.error(`COLLIE_TOKEN must be set to at least ${TOKEN_MIN_BYTES} bytes. Make one with: openssl rand -hex 32`);
  process.exit(1);
}
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8420);

// On world-local the queue runs in this process, and so does the recovery of sessions a crash left unfinished.
// Start the World before the first request, so a session that was waiting resumes at once.
await getWorld();

const collie = collieRoute({ open, name: NAME, token });
const chat = chatRoute({ open, name: NAME, agent: { model: MODEL, instructions: INSTRUCTIONS }, authorize: "public" });
const flow = flowHandler();
const unauthorized = () => new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });

async function route(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/collie/")) return collie(request); // Collie's route checks the token itself
  // The chat and flow routes are public in durable-harness; this server puts the same token in front of them.
  if (!(await tokenAccepted(request, token))) return unauthorized();
  if (path === "/api/chat") return request.method === "POST" ? chat.POST(request) : chat.GET(request);
  if (path === "/.well-known/durable-harness/v1/flow") return flow(request);
  return new Response("not found", { status: 404 });
}

/** A Node request as a web `Request`, and the web `Response` written back as it streams. */
async function serve(req: IncomingMessage, res: ServerResponse) {
  const stop = new AbortController();
  res.on("close", () => stop.abort());
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const reply = await route(new Request(url, { method: req.method, headers, signal: stop.signal, ...(body === undefined ? {} : { body }) }));
  res.writeHead(reply.status, Object.fromEntries(reply.headers));
  if (reply.body === null) return void res.end();
  for await (const chunk of reply.body) res.write(chunk);
  res.end();
}

const server = createServer((req, res) => {
  serve(req, res).catch((e) => {
    console.error(`request failed: ${String(e?.message ?? e)}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.listen(port, host, () => console.log(`desk listening on http://${host}:${(server.address() as { port: number }).port}`));
// A stop is safe: a session that was mid-turn resumes at the next start. A tool already running finishes in this process first.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
