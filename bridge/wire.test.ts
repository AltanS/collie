import { describe, expect, test } from "bun:test";

import { decodeReplyLine } from "./wire.ts";

// The reply decoder is the pure core of the socket adapter: JSON parse plus result/error
// discrimination. Exercising it here covers the wire shapes without needing a live Herdr socket.

describe("decodeReplyLine", () => {
  test("returns the result payload of a success reply", () => {
    const r = decodeReplyLine<{ panes: number[] }>(
      '{"id":"b1","result":{"panes":[1,2]}}',
      "pane.list",
    );
    expect(r).toEqual({ panes: [1, 2] });
  });

  test("throws an error reply's code and message", () => {
    expect(() =>
      decodeReplyLine(
        '{"id":"","error":{"code":"invalid_key","message":"unsupported key X"}}',
        "pane.send_keys",
      ),
    ).toThrow("herdr pane.send_keys: invalid_key: unsupported key X");
  });

  test("throws on malformed JSON", () => {
    expect(() => decodeReplyLine("{not json", "workspace.list")).toThrow(/bad reply/);
  });

  test("throws on JSON that is neither a result nor an error", () => {
    expect(() => decodeReplyLine('{"id":"b1"}', "pane.list")).toThrow(/unexpected reply shape/);
  });
});
