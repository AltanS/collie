import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { loadChatTail, saveChatTail } from "@/lib/chat-tail";
import { KeepChatControl } from "./keep-chat-control";

afterEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem("collie:display-prefs:v4") ?? "{}");

// M46 spec 09: "Keep chat on this phone", Off, 1 day or 7 days, in Settings → Device.
describe("KeepChatControl", () => {
  it("starts at 1 day and stores a new choice", async () => {
    render(<KeepChatControl />);
    expect(screen.getByText("Keep chat on this phone")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "1 day" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "7 days" }));
    expect(stored().keepChat).toBe("7d");
    expect(screen.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
  });

  it("deletes what is kept when turned off", async () => {
    await saveChatTail(undefined, "w1:p1", [
      { uuid: "a", seq: 1, ts: "", role: "assistant", parts: [{ kind: "text", text: "kept" }] },
    ], "1d");
    expect(await loadChatTail(undefined, "w1:p1")).not.toBeNull();
    render(<KeepChatControl />);
    await userEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(stored().keepChat).toBe("off");
    await waitFor(async () => expect(await loadChatTail(undefined, "w1:p1")).toBeNull());
  });
});
