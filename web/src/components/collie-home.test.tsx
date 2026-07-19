import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CollieHome } from "./collie-home";

describe("CollieHome", () => {
  it("returns home when tapped", async () => {
    const onHome = vi.fn();
    render(<CollieHome onHome={onHome} trouble={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Collie home" }));
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("shows the static app icon at rest and the galloping sprite once troubled", () => {
    const { container, rerender } = render(<CollieHome trouble={false} />);
    // Rest = the original app icon, no gallop sprite mounted.
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("src", "/favicon.svg");
    rerender(<CollieHome trouble />);
    // Sustained trouble = the animated sprite replaces the static icon.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
  });

  it("rests on the muted static icon (never a frozen sprite) once the outage escalates to lost", () => {
    // Galloping = "still trying"; once the reconnect gives up (lost) the sprite is gone entirely. It is
    // replaced by the STATIC app icon, muted — not a paused gallop frame, whose full-stretch mid-stride
    // pose looked "stuck mid-run" (the exact complaint).
    const { container } = render(<CollieHome trouble lost />);
    expect(container.querySelector(".dog-gallop")).toBeNull();
    const icon = container.querySelector("img");
    expect(icon).toHaveAttribute("src", "/favicon.svg");
    expect(icon?.className).toMatch(/grayscale/);
    expect(screen.getByRole("button", { name: "Collie home — not connected" })).toBeInTheDocument();
  });

  it("gallops while troubled but NOT yet lost", () => {
    const { container } = render(<CollieHome trouble lost={false} />);
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
    expect(screen.getByRole("button", { name: "Collie home — reconnecting" })).toBeInTheDocument();
  });

  it("shows the wordmark only when asked", () => {
    const { rerender } = render(<CollieHome trouble={false} />);
    expect(screen.queryByText("Collie")).toBeNull();
    rerender(<CollieHome trouble={false} wordmark />);
    expect(screen.getByText("Collie")).toBeInTheDocument();
  });
});
