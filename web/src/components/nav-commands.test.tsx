import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NavCommands } from "./nav-commands";

describe("NavCommands", () => {
  it("fires onHome and onNewTab on a single tap", async () => {
    const user = userEvent.setup();
    const onHome = vi.fn();
    const onNewTab = vi.fn();
    render(<NavCommands onHome={onHome} onNewTab={onNewTab} onKill={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /home/i }));
    await user.click(screen.getByRole("button", { name: /new tab/i }));
    expect(onHome).toHaveBeenCalledOnce();
    expect(onNewTab).toHaveBeenCalledOnce();
  });

  it("requires two taps to Kill — first arms the confirm, second fires", async () => {
    const user = userEvent.setup();
    const onKill = vi.fn();
    render(<NavCommands onHome={vi.fn()} onNewTab={vi.fn()} onKill={onKill} />);

    await user.click(screen.getByRole("button", { name: /kill/i }));
    expect(onKill).not.toHaveBeenCalled();
    expect(screen.getByText(/confirm/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onKill).toHaveBeenCalledOnce();
  });

  it("disables New tab when no current pane and Kill when killDisabled", () => {
    render(<NavCommands onHome={vi.fn()} onKill={vi.fn()} killDisabled />);
    expect(screen.getByRole("button", { name: /new tab/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /kill/i })).toBeDisabled();
  });
});
