import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { sendReply } from "./api";
import { describeApiError, describeThrownError } from "./api-error-message";
import { __resetLocale, setLocale, whenLocaleReady } from "./i18n";

// The one place a bridge refusal becomes words. What is pinned here is the FALLBACK LADDER, because
// every rung of it is a case that only shows up against a bridge of a different age than this app:
// a code from tomorrow, a body from yesterday, a proxy that answered instead of the bridge.

beforeEach(() => {
  localStorage.clear();
  __resetLocale();
});

describe("describeApiError", () => {
  it("translates a known code and fills its slots from detail", () => {
    expect(
      describeApiError({
        error: "unsupported type: image/tiff",
        code: "upload.bad_type",
        detail: { type: "image/tiff" },
      }),
    ).toBe("Collie can't send that kind of file: image/tiff");
  });

  it("frames a passthrough reason without translating the reason itself", () => {
    // `{reason}` is the multiplexer's own words (bridge/error-codes.ts) — the frame is ours, the
    // remainder is not, and it must survive byte for byte.
    expect(
      describeApiError({ error: "no such pane", code: "pane.close_failed", detail: { reason: "no such pane" } }),
    ).toBe("The pane couldn't be closed: no such pane");
  });

  it("falls back to the bridge's own sentence for a code this build has never met", () => {
    // A NEWER bridge. Not an error, not a bug — and never a raw `apiError.…` key on screen.
    const said = describeApiError({ error: "the kennel is full", code: "kennel.full" });
    expect(said).toBe("the kennel is full");
    expect(said).not.toContain("apiError.");
  });

  it("falls back to the bridge's sentence when there is no code at all", () => {
    // An OLDER bridge: `{ ok: false, error }` and nothing else, exactly as it shipped.
    expect(describeApiError({ error: "herdr said no" })).toBe("herdr said no");
  });

  it("prefers the code over the sentence, so the words are the operator's language", () => {
    expect(describeApiError({ error: "no file", code: "upload.no_file" })).toBe("No file was sent.");
  });

  it("uses the caller's surface line only when the body carried no words", () => {
    expect(describeApiError({ error: "   " }, "Rename failed")).toBe("Rename failed");
    // …and never above the bridge's own sentence, which says strictly more.
    expect(describeApiError({ error: "herdr said no" }, "Rename failed")).toBe("herdr said no");
  });

  it("says something true when the body carried nothing at all", () => {
    expect(describeApiError({})).toBe("Something went wrong. Try again.");
  });

  it("renders the active language", async () => {
    setLocale("de");
    await whenLocaleReady("de");
    expect(describeApiError({ error: "no file", code: "upload.no_file" })).toBe(
      "Es wurde keine Datei übermittelt.",
    );
    expect(
      describeApiError({ error: "x", code: "session.unknown", detail: { session: "work" } }),
    ).toBe("Keine Sitzung namens work auf diesem collie vorhanden.");
  });
});

describe("describeThrownError", () => {
  it("reads the code off a thrown ApiError's body", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () =>
        HttpResponse.json(
          { ok: false, error: "unknown session: work", code: "session.unknown", detail: { session: "work" } },
          { status: 404 },
        ),
      ),
    );
    const thrown = await sendReply("w1:p1", "hi").catch(<TThrown,>(e: TThrown) => e);
    expect(describeThrownError(thrown)).toBe("There is no session called work on this collie.");
  });

  it("keeps a non-JSON refusal's own message — a proxy page is not a bridge body", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () => new HttpResponse("herdr down", { status: 502 })),
    );
    const thrown = await sendReply("w1:p1", "hi").catch(<TThrown,>(e: TThrown) => e);
    expect(describeThrownError(thrown)).toContain("herdr down");
  });

  it("keeps an ordinary Error's message", () => {
    expect(describeThrownError(new Error("Failed to fetch"))).toBe("Failed to fetch");
  });

  it("does not put an empty string on screen for a thrown non-Error", () => {
    expect(describeThrownError("boom")).toBe("Something went wrong. Try again.");
    expect(describeThrownError(new Error("  "))).toBe("Something went wrong. Try again.");
  });
});
