import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BackdropSection } from "./backdrop";

describe("the backdrop round", () => {
  it(
    "shows three numbered options, each with its own ground",
    async () => {
      const { container } = render(<BackdropSection />);
      const handles = [...container.querySelectorAll(".pg-grid > *")].map((el) => el.getAttribute("data-state"));
      expect(handles).toEqual(["backdrop-option-1", "backdrop-option-2", "backdrop-option-3"]);

      const labels = [...container.querySelectorAll(".pg-grid > *")].map((el) => el.firstElementChild?.textContent);
      expect(labels).toEqual(["1Crossed grain", "2Dot grid", "3Ruled lines"]);

      await waitFor(() => expect(container.querySelectorAll("[data-pg-ground]").length).toBe(3), { timeout: 12_000 });
      const images = [...container.querySelectorAll<HTMLElement>("[data-pg-ground]")].map((el) => el.style.getPropertyValue("--ground-image"));
      expect(images[0]).toContain("repeating-linear-gradient(45deg");
      expect(images[1]).toContain("radial-gradient");
      expect(images[2]).toContain("repeating-linear-gradient(to bottom");
    },
    30_000,
  );
});
