import { render } from "@testing-library/react";

import { WalkyIcon } from "./walky-icon";

describe("WalkyIcon", () => {
  it("is a lucide-class, decorative svg on the 24 grid", () => {
    const { container } = render(<WalkyIcon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.classList.contains("lucide")).toBe(true);
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg!.getAttribute("width")).toBe("24");
    expect(svg!.getAttribute("height")).toBe("24");
    expect(svg!.getAttribute("fill")).toBe("none");
    expect(svg!.getAttribute("stroke")).toBe("currentColor");
    expect(svg!.getAttribute("stroke-linecap")).toBe("round");
    expect(svg!.getAttribute("stroke-linejoin")).toBe("round");
  });

  it("draws the radio body, the antenna, the speaker slot and the two arcs", () => {
    const { container } = render(<WalkyIcon />);
    expect(container.querySelectorAll("rect")).toHaveLength(1);
    expect(container.querySelectorAll("path")).toHaveLength(4);
  });

  it("merges a passed className next to the lucide class", () => {
    const { container } = render(<WalkyIcon className="size-3.5 shrink-0" />);
    const svg = container.querySelector("svg")!;
    expect(svg.classList.contains("lucide")).toBe(true);
    expect(svg.classList.contains("size-3.5")).toBe(true);
    expect(svg.classList.contains("shrink-0")).toBe(true);
  });

  it("lets a caller label it, which drops aria-hidden", () => {
    const { container } = render(<WalkyIcon aria-label="Messages" role="img" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe("Messages");
    expect(svg.getAttribute("aria-hidden")).toBeNull();
  });
});
