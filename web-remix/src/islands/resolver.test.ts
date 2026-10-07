import { describe, expect, test } from "bun:test";

import { refusalOf } from "./refusal";

const answer = (status: number, headers: Record<string, string>) => ({ status, headers: new Headers(headers) });
const OURS = { "x-collie-document": "islands", "x-collie-build": "b1" };

describe("refusalOf (S3, the resolver's verdict on a top-frame answer)", () => {
  test("this build's islands document is taken, a 4xx one too", () => {
    expect(refusalOf(answer(200, OURS), "b1")).toBeNull();
    expect(refusalOf(answer(404, OURS), "b1")).toBeNull();
  });

  test("a 5xx, a page without the marker, and another build are refused", () => {
    expect(refusalOf(answer(502, OURS), "b1")).toBe("status");
    expect(refusalOf(answer(200, { "x-collie-build": "b1" }), "b1")).toBe("not-a-document");
    expect(refusalOf(answer(200, { ...OURS, "x-collie-build": "b2" }), "b1")).toBe("build-skew");
    expect(refusalOf(answer(200, { "x-collie-document": "islands" }), "b1")).toBe("build-skew");
  });
});
