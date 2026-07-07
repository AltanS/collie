import { describe, expect, test } from "bun:test";

import { decodeReplyLine, decodeStreamLine } from "./wire.ts";

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

describe("decodeStreamLine", () => {
  test("recognizes the subscription ack", () => {
    expect(decodeStreamLine('{"id":"es1","result":{"type":"subscription_started"}}')).toEqual({
      kind: "ack",
    });
  });

  test("decodes an event line (snake_case name + data)", () => {
    expect(
      decodeStreamLine('{"data":{"pane_id":"w6:p3","workspace_id":"w6"},"event":"pane_agent_detected"}'),
    ).toEqual({
      kind: "event",
      event: "pane_agent_detected",
      data: { pane_id: "w6:p3", workspace_id: "w6" },
    });
  });

  test("returns (does not throw) a pre-ack error line so the caller can report the reason", () => {
    expect(decodeStreamLine('{"id":"","error":{"code":"invalid_request","message":"missing field `pane_id`"}}')).toEqual({
      kind: "error",
      code: "invalid_request",
      message: "missing field `pane_id`",
    });
  });

  test("throws on malformed JSON", () => {
    expect(() => decodeStreamLine("{not json")).toThrow(/bad stream line/);
  });

  test("throws on an unrecognized shape and on a non-string event name", () => {
    expect(() => decodeStreamLine('{"id":"es1"}')).toThrow(/unrecognized stream line/);
    expect(() => decodeStreamLine('{"result":{"type":"nope"}}')).toThrow(/unexpected ack shape/);
    expect(() => decodeStreamLine('{"event":42,"data":{}}')).toThrow(/event name not a string/);
  });
});
