import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __reloadProjectPictures, __resetProjectPictures, projectPicturesOn } from "@/lib/project-picture";
import { ProjectPicturesControl } from "./project-pictures-control";

const KEY = "collie:project-pictures:v1";

beforeEach(() => __resetProjectPictures());
afterEach(() => {
  cleanup();
  __resetProjectPictures();
});

describe("ProjectPicturesControl", () => {
  it("reads on by default and stores nothing", () => {
    render(<ProjectPicturesControl />);
    expect(screen.getByRole("switch", { name: "Project pictures" })).toBeChecked();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("stores off on a tap, and on again on the next", async () => {
    const user = userEvent.setup();
    render(<ProjectPicturesControl />);
    const sw = screen.getByRole("switch", { name: "Project pictures" });
    await user.click(sw);
    expect(sw).not.toBeChecked();
    expect(localStorage.getItem(KEY)).toBe("off");
    expect(projectPicturesOn()).toBe(false);
    await user.click(sw);
    expect(sw).toBeChecked();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("reads off on a device that stored off", () => {
    localStorage.setItem(KEY, "off");
    // The store read its key at load; a reload re-reads it.
    __reloadProjectPictures();
    render(<ProjectPicturesControl />);
    expect(screen.getByRole("switch", { name: "Project pictures" })).not.toBeChecked();
  });
});
