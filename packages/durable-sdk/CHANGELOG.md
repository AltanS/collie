# Changelog

`@colliepwa/durable-sdk` has its own version, apart from Collie's, and follows [Semantic Versioning](https://semver.org/).
Each version names the durable wire version it speaks. Until the package leaves the `experimental` dist-tag, a minor
release may change the API.

## [0.1.0]

- **The first package.** The durable SDK, built from `packages/durable-sdk` in the Collie repo.
- **Wire version 1.** `WIRE_VERSION` is 1, and `SDK_VERSION` is this package's version.
- **Bun and Node, one import.** `openCollie` picks the Bun server, with the descendant check, on Bun, and the
  `node:http` server, which cannot run that check, on Node 22.19 or later. `./bun` and `./node` force one.
- **`./pi` for Pi Durable 1.1 and 1.2.** The Pi Durable glue, with `@earendil-works/pi-durable`, `pi-ai` and `chord`
  1.1 or later and below 2 as optional peers. It is tested with 1.1.0 and 1.2.0. A tool returns both `content` (1.1) and
  `output` (1.2) through `toolResult`. A pane shows a notice when the Pi session fails, and the error goes to the log.
  `./core` is the wire without a transport.
- **Decoded JSON in, not `unknown`.** The public functions take `Json | undefined` instead of `unknown`, and `Json` and
  `JsonObject` are exported, so a consumer passes decoded JSON.
- **The Pi helpers can put a clock on a question.** `riskGuard` and `askTools` take `timeoutMs`, and the ask carries `expiresAt`; past it the call is blocked, or the tool returns "timed out", and `onTimeout` lets the program log it.
