import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { loadChatTail, saveChatTail } from "@/lib/chat-tail";
import { loadLastPaneText, loadLastSnapshot, saveLastPaneText, saveLastSnapshot } from "@/lib/last-seen";
import { getDeviceToken, setDeviceToken } from "@/lib/pairing";
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

describe("Clear saved copies now", () => {
  it("deletes every saved record, keeps the pairing and the setting, and says so", async () => {
    setDeviceToken("tok-placeholder");
    await saveChatTail(undefined, "w1:p1", [
      { uuid: "a", seq: 1, ts: "", role: "assistant", parts: [{ kind: "text", text: "kept" }] },
    ], "7d");
    await saveLastPaneText(undefined, "w1:p1", "pane text");
    await saveLastSnapshot(undefined, { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], ts: 1 });
    render(<KeepChatControl />);
    await userEvent.click(screen.getByRole("radio", { name: "7 days" }));
    expect(screen.queryByText("Saved copies cleared.")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Clear saved copies now" }));

    expect(await screen.findByText("Saved copies cleared.")).toBeInTheDocument();
    expect(await loadChatTail(undefined, "w1:p1")).toBeNull();
    expect(await loadLastPaneText(undefined, "w1:p1")).toBeNull();
    expect(await loadLastSnapshot(undefined)).toBeNull();
    expect(getDeviceToken()).toBe("tok-placeholder");
    expect(stored().keepChat).toBe("7d");
  });
});
