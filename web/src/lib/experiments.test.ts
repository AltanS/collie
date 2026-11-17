import { EXPERIMENTS, hasExperiments } from "@/lib/experiments";

describe("the experiments list", () => {
  it("holds the Hill and tricks, newest last, so the section exists", () => {
    expect([...EXPERIMENTS]).toEqual(["hill", "tricks"]);
    expect(hasExperiments()).toBe(true);
  });
});
