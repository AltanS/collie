import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CollieHome } from "./collie-home";

describe("CollieHome", () => {
  it("returns home when tapped", async () => {
    const onHome = vi.fn();
    render(<CollieHome onHome={onHome} connecting={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Collie home" }));
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("shows the static app icon at rest and the galloping sprite while connecting", () => {
    const { container, rerender } = render(<CollieHome connecting={false} />);
    // Rest = the original app icon, no gallop sprite mounted.
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("src", "/favicon.svg");
    rerender(<CollieHome connecting />);
    // Connecting = the animated sprite replaces the static icon.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
  });

  it("shows the wordmark only when asked", () => {
    const { rerender } = render(<CollieHome connecting={false} />);
    expect(screen.queryByText("Collie")).toBeNull();
    rerender(<CollieHome connecting={false} wordmark />);
    expect(screen.getByText("Collie")).toBeInTheDocument();
  });
});
