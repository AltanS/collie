import { describe, expect, it } from "vitest";

import { stopNotice } from "@/components/send-notice";
import { t } from "@/lib/i18n";

describe("stopNotice", () => {
  it("a pressed receipt that opened a dialog says so and points at the card", () => {
    const notice = stopNotice({ requestId: "stop-req-0001", outcome: "pressed", reason: "dialog_open", keys: ["Escape"] });
    expect(notice.sentence).toBe(t("belt.stop.receipt.pressedDialog"));
    expect(notice.sentence).toBe("Stop sent. A dialog opened. Answer it on its card.");
    expect(notice.toCard).toBe(true);
    expect(notice.tone).toBe("caution");
  });

  it("a plain pressed receipt keeps the working sentence and does not point at a card", () => {
    const notice = stopNotice({ requestId: "stop-req-0001", outcome: "pressed", keys: ["Escape"] });
    expect(notice.sentence).toBe(t("belt.stop.receipt.pressed"));
    expect(notice.toCard).toBe(false);
  });

  it("the dialog_open refusal still points at the card", () => {
    expect(stopNotice({ requestId: "stop-req-0001", outcome: "refused", reason: "dialog_open" }).toCard).toBe(true);
  });

  it("an older crew member's answer says to update that machine; no answer says the Stop may have gone in", () => {
    const old = stopNotice({ requestId: "stop-req-0001", outcome: "refused", reason: "unsupported_build" });
    expect(old.sentence).toBe("This machine cannot stop from the phone yet. Update it.");
    expect(old.toCard).toBe(false);
    const unknown = stopNotice({ requestId: "stop-req-0001", outcome: "unknown" });
    expect(unknown.sentence).toBe(t("belt.stop.receipt.unknown"));
    expect(unknown.sentence).toMatch(/may have gone in/u);
    expect(unknown.tone).toBe("caution");
  });
});
