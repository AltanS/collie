// The wire's protocol suite against the durable-harness route (M66 spec 03), once with one route instance and once
// with two that take turns on every request over one World. See mirror.ts for how a program reaches the route.
import { protocolSuite } from "../../durable-member/tests/protocol-suite.ts";
import { mirrorTransport } from "./mirror.ts";

/** What this host does not do, by design, with the reason. Each is a test of the memory host's own behaviour. */
const NO_STARTERS = "this host offers no starters (caps.starters is false)";
const NO_RENAME = "this host keeps no titles of its own (caps.rename is false)";
const NO_CLOSE = "a pane is a run, closed by the program, not the phone (caps.close is false)";
const NO_ACTIONS = "this host offers no pane actions (caps.actions is false)";
const NO_REOPEN = "a run that ended does not come back (caps.reopen is false)";
const TAILS = "a cursor names a whole view on this host: the same cursor reads nothing, any other one a reset (WIRE.md A.1)";
const ONE_REVISION = "a journal fixes an ask at its first record: it is never changed in place, so its revision stays 1";
const NO_STEER = "steer is off: a send is taken only while the pane is idle, so a send to a busy or waiting pane is 409 not-supported";
const CONTROLS = "every pane takes send and stop through the route's controls; the route cannot see whether the program has a handler";
const READY = "ready is whether the World answers; an unknown route reads nothing, so it is 404 at once";

export const SKIP: Record<string, string> = {
  "hello reports the range, host and caps": "this host offers asks, send, abort and history only; route.test.ts checks its caps",
  "a bad cursor, or no epoch, is 400 bad-cursor": `${TAILS} (it reads the pane the skipped test before it makes)`,
  "the check order is version, hello, ready, route": READY,
  "a POST body over 64 KiB is 413 too-large, on every POST route": NO_STARTERS,
  "a request whose id breaks the rule is 400 bad-id; a missing or mistyped field is 400 bad-body": NO_STARTERS,
  "lists the layout, the starters, and each pane's turnId": NO_STARTERS,
  "the snapshot keeps its first 64 workspaces, 256 tabs and 256 panes, and 50 starters": NO_STARTERS,
  "after=N returns what is past N and a next cursor": TAILS,
  "a cursor from another epoch gets reset and the whole current view": TAILS,
  "an ask carries toolCallId, revision, title and itemId; it sets waiting; answer resolves it by phone; a second answer is 409 decided with the first outcome": TAILS,
  "a stale revision is 409 stale with the current ask, turnId and askIds; the ask stays open": ONE_REVISION,
  "an aborted signal closes the ask as stopped and rejects it": TAILS,
  "the same request id on another route, pane or starter is 409 request-id-reused": NO_STARTERS,
  "send reaches onSend with the text, steer and the request id": NO_STEER,
  "a stale turnId or askId is 409 stale with the current turnId and askIds, and nothing runs": NO_STEER,
  "steer: true with caps.steer false is 409 not-supported; send with caps.send false is too": NO_STARTERS,
  "every kind keeps the stable id and the revision rule: the id comes from the pane and toolCallId, and a stale revision is 409": ONE_REVISION,
  "onSend runs for a pane with no handler, with a typed payload: text, steer, the turn and the request id": NO_STEER,
  "a pane with no handler and no hook is still 409 not-supported": CONTROLS,
  "onRename gets the request id, and false is 422": NO_RENAME,
  "the old onRename option still works as an alias, and hooks.onRename wins when both are set": NO_RENAME,
};
for (const t of ["rename a tab: the snapshot shows the title and rev rose; panes keep their own title", "rename a workspace", "the same request id for another title or target is 409 request-id-reused", "the hook answering false is 422 rename-refused, nothing changes, and the same id may try again", "an unknown workspace or tab is 404 no-such-target, and the hook is not asked", "a bad title is 400 bad-body: not a string, empty, blank, over 120 characters, or with a control character"]) SKIP[t] = NO_RENAME;
for (const t of ["close a pane: it leaves the snapshot, rev rose, its tab and the other pane stay, and its log is gone", "close a tab: the tab and the panes inside it go, the rest stay", "close a workspace: its tabs and panes go with it", "every open ask on a closed pane closes as stopped, and nobody answers it", "the hook gets the target, the panes that go with it, and the request id", "the same request id for another kind or target is 409 request-id-reused", "the hook answering false is 422 close-refused, nothing changes, and the same id may try again", "an unknown target is 404 no-such-target, a target of the wrong kind too, and the hook is not asked", "with no hook at all a close just removes the target"]) SKIP[t] = NO_CLOSE;
SKIP["a repeat of the request id answers from the receipt, asks the hook once, and does not move rev"] = `${NO_RENAME}; ${NO_CLOSE}`;
for (const t of ["a pane's actions are in the snapshot in the program's order, and a pane with none carries no key", "at most 4 actions, a label cut to 16 characters, an unknown icon dropped, an empty label and a repeated id left out", "a tap runs the hook once with the typed payload, and a repeat of the request id answers from the receipt", "a pane's own handler wins over the hook, and the same request id for another action is 409 request-id-reused", "a stale turn is 409 stale with the current turn, and the hook is not run", "an unknown pane is 404 no-such-pane, an action the pane does not list is 404 no-such-action", "the hook answering false is 422 action-refused, and the same request id may try again", "a disabled or busy action takes no tap: 422 action-refused, and the hook is not run"]) SKIP[t] = NO_ACTIONS;
for (const t of ["a starter returns the pane it made", "a repeat with the same request id returns the first paneId with replayed: true and runs nothing", "a failure is 422 starter-failed with its message, stores nothing, and the same id may run again", "a starter that names a pane that is not in the layout fails with 422", "a repeat while the first is still starting waits for it, and nothing runs twice"]) SKIP[t] = NO_STARTERS;
for (const t of ["reopen: a pane closed in this process comes back with the same pane id, its items, and rev rose", "reopen: the hook shows a conversation closed before a restart; false is 422 reopen-refused and the id may run again", "reopen: a hook that shows nothing for a conversation this process never closed is 422 reopen-refused", "reopen: an unknown conversation is 404 no-such-target, an open one answers ok and changes nothing", "reopen: a body without an id is 400, and the same request id for another conversation is request-id-reused"]) SKIP[t] = NO_REOPEN;

protocolSuite(mirrorTransport("the durable-harness route, one instance", 1, SKIP));
protocolSuite(mirrorTransport("the durable-harness route, two instances taking turns", 2, SKIP));
