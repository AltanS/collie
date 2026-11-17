// A skip for the tests that need a real Unix socket of the local API (M105), test code only; nothing in the
// bridge imports it.
//
// The local API does not stand on Windows in this release: tricks are closed there behind the gate
// (`TricksService.gated`), the socket follows "tricks run here", and `ApiSocket.start()` answers false with
// no folder and no socket. So a test that starts the server and dials it cannot run there. Each one is
// `apiSocketTest` or `apiSocketDescribe`, a skip on win32, as `dataTest` is for the data path. The Windows
// answer itself (no socket, said once; the gate; the line of `collie api`) is proven on every system with an
// injected platform: socket.test.ts, tricks/service.test.ts and cli/api.test.ts. A test of pure logic that
// shares a file with these (the table, the framing parser, the ids, the print) runs on Windows.

import { describe, test } from "bun:test";

import { HOST } from "../host.ts";

/** The one reason for every skip below: no local API on Windows yet, because tricks are gated there. */
export const NO_API_ON_WINDOWS = "the local API does not stand on Windows before the Windows gate for tricks opens";

const NO_SOCKET = HOST.platform === "win32";
export const apiSocketTest = test.skipIf(NO_SOCKET);
export const apiSocketDescribe = describe.skipIf(NO_SOCKET);
