// A program on the Node entry of the SDK, run by Node itself (sdk-split.test.ts). It opens the socket named by
// DM_SOCK, shows one pane, asks for one approval with `requireApproval`, and prints what came back, one JSON line
// per step: `listening`, then the approval, then `closed`.
import { openCollie, requireApproval } from "../../../packages/durable-sdk/src/node/index.ts";

const lines: string[] = [];
const collie = await openCollie({ socket: process.env.DM_SOCK!, hostName: "node", caps: { asks: true }, warn: (line) => lines.push(line) });
const pane = collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "node" });
collie.ready();
console.log(JSON.stringify({ step: "listening", warned: lines }));
const approval = await requireApproval("refund", { order: "5521", amount: 40 }, { pane, toolCallId: "call-1" });
console.log(JSON.stringify({ step: "approval", approved: approval.approved, decidedBy: approval.decidedBy }));
// Close right after the answer: the answer's reply must still reach the caller.
await collie.close();
console.log(JSON.stringify({ step: "closed" }));
