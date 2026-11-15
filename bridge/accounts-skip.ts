// A skip for the tests of Accounts (M101), test code only; nothing in the bridge imports it.
//
// Accounts are off on Windows by decision: the route answers 404 there and the app hides the page. The
// feature rests on POSIX folder forms (`~/x`, a leading `/`), symlinks and the 0700 mode, so its tests
// are written in those forms and cannot hold on a Windows path module. Each one is `accountTest`, a skip
// on win32, as `dataTest` is for the data path. The Windows answer itself (404, no offer, a refused add)
// is proven everywhere with an injected platform, in accounts-routes.test.ts.

import { test } from "bun:test";

import { HOST } from "./host.ts";

export const accountTest = test.skipIf(HOST.platform === "win32");
