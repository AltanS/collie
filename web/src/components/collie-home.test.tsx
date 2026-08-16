import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CollieHome } from "./collie-home";

describe("CollieHome", () => {
  it("returns home when tapped", async () => {
    const onHome = vi.fn();
    render(<CollieHome onHome={onHome} />);
    await userEvent.click(screen.getByRole("button", { name: "Collie home" }));
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("uses generic loading animation and independent static degraded treatment", () => {
    const { container, rerender } = render(<CollieHome />);
    expect(container.querySelector(".dog-gallop")).toBeNull();

    rerender(<CollieHome loading />);
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
    expect(screen.getByRole("button", { name: "Collie home" })).toBeInTheDocument();

    rerender(<CollieHome degraded />);
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(container.querySelector("img")?.parentElement).toHaveClass("grayscale");
  });

  it("shows the wordmark only when asked", () => {
    const { rerender } = render(<CollieHome />);
    expect(screen.queryByText("Collie")).toBeNull();
    rerender(<CollieHome wordmark />);
    expect(screen.getByText("Collie")).toBeInTheDocument();
  });
});
