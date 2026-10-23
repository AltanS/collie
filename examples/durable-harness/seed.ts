// Start two sessions on a running server, so a phone has something to read:
//   one asks to ship an order (a card waits for Allow or Deny), one looks up stock and finishes.
//   COLLIE_TOKEN=... node seed.ts            (SEED_URL, default http://127.0.0.1:8420)
// The turns run in the server, which holds the queue, not here. This script only asks the chat route to start them.
export {};
const base = process.env.SEED_URL ?? "http://127.0.0.1:8420";
const token = process.env.COLLIE_TOKEN;
if (token === undefined || token === "") {
  console.error("COLLIE_TOKEN must be set to the server's token");
  process.exit(1);
}

/** POST one message, read the session id from the headers, and let the turn run on. Returns the id. */
async function start(text: string): Promise<string> {
  const reply = await fetch(`${base}/api/chat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const id = reply.headers.get("x-session-id");
  if (reply.status !== 200 || id === null) throw new Error(`the chat route answered ${reply.status}: ${(await reply.text()).slice(0, 200)}`);
  // The route streams the turn until it settles. A question can hold it for minutes, so stop reading once the turn has begun.
  const reader = reply.body?.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (reader !== undefined && !/"type":"(tool_start|idle)"/.test(seen)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  await reader?.cancel();
  return id;
}

console.log(`started ${await start("Please ship order 5521: the blue mug")}`);
console.log(`started ${await start("How is the stock of the red mug?")}`);
