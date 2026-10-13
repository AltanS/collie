# @colliepwa/durable-sdk

Show a long-running agent program on your phone through [Collie](https://colliepwa.dev). Your program opens a
private Unix socket, lays out its conversations as panes, and asks its questions there. Collie dials the socket and
shows each question as a card on the phone, with chat and history, and you answer with one tap.

**Experimental.** The package is published under the npm dist-tag `experimental`, never `latest`. The durable wire may
change, or the feature may be removed, in a later minor release of Collie. The full guide is the
[Programs page](https://colliepwa.dev/docs/durable-programs).

## Install

```sh
npm install @colliepwa/durable-sdk@experimental
# or
bun add @colliepwa/durable-sdk@experimental
```

It needs Node 22.18 or later, or Bun 1.4 or later, on Linux or macOS. It has no runtime dependency.

## A first program

This program shows one question on the phone, prints the answer and exits:

```ts
import { openCollie } from "@colliepwa/durable-sdk";

const socket = process.env.COLLIE_DURABLE_SOCKET ?? `${process.env.XDG_RUNTIME_DIR}/hello/app.sock`;
const collie = await openCollie({ socket, hostName: "hello", caps: { asks: true } });
const pane = collie.workspace("hello", { title: "Hello" }).tab("main", { title: "Questions" }).pane("deploy", { title: "Deploy", harness: "hello" });
collie.ready();
console.log(`listening ${collie.address}`);
const options = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }];
const answer = await pane.ask({ kind: "choice", toolCallId: "deploy-1", itemId: "deploy-1", title: "Deploy to staging?", options });
console.log(`answer: ${answer.optionIds[0]}`);
await collie.close();
```

Run it with `node hello.mjs` (or save it as `hello.ts` and run `bun hello.ts`), then attach the socket it printed to
your Collie: `collie durable attach hello --socket <path> --restart`.

To ask before a tool runs, `requireApproval(toolName, args, { pane, toolCallId })` raises an Allow and Deny card and
returns who decided and when. Only Allow from the phone approves.

## The entries

| Import | What it is |
| --- | --- |
| `@colliepwa/durable-sdk` | `openCollie` and the whole API. On Bun it serves the socket with the descendant check, elsewhere with `node:http`. |
| `@colliepwa/durable-sdk/bun` | The Bun server only. |
| `@colliepwa/durable-sdk/node` | The `node:http` server only. |
| `@colliepwa/durable-sdk/pi` | The glue for a [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) program: a conversation as a pane, a risky tool call as a card, history from Pi's store. |
| `@colliepwa/durable-sdk/core` | The layout and the wire as one function, `handle(request)`, for a program that brings its own transport. |

**On Node, a program cannot read who connects to its socket.** Node has no way to read the caller of a Unix socket, so
the descendant check (which refuses an answer from the program itself or from a process it started) cannot run, and
the Node server writes one line at start that says so. Any process of your user can answer a card. Run the agent's
tools in a sandbox that cannot reach the socket, or run the program on Bun.

`./pi` needs `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord`, 1.1 or later and below
2. They are optional peer dependencies: install them yourself, and a program that never imports `./pi` needs none.

## Versions

The package has its own version, apart from Collie's. `SDK_VERSION` is that version, and `WIRE_VERSION` is the
durable wire version it speaks, which is 1. The contract is
[WIRE.md](https://github.com/AltanS/collie/blob/main/bridge/mux/durable/WIRE.md).

## Publish

Only Altan publishes this package, from his own npm account. CI never publishes. Before a publish:

- bump the version in `packages/durable-sdk/package.json`, and add its section to `packages/durable-sdk/CHANGELOG.md`
- commit, so the tree is clean
- run `bun run sdk:build` and `scripts/sdk-pack-check.sh` at the repo root, and see `pack check: ok`

Then:

```sh
cd packages/durable-sdk
npm publish --access public --tag experimental
```

## License

MIT. See [LICENSE](./LICENSE).
