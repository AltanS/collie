import { describe, expect, it } from "vitest";

import { isDestructiveInput } from "./destructive";

describe("isDestructiveInput — flags destructive commands", () => {
  const positives: [input: string, reasonFragment: string][] = [
    ["rm -rf /", "rm -r"],
    ["rm -rf node_modules", "rm -r"],
    ["rm -fr build", "rm -r"],
    ["rm -rfv dist", "rm -r"],
    ["rm -r ./tmp", "rm -r"],
    ["rm --recursive ./tmp", "rm -r"],
    ["sudo systemctl restart nginx", "sudo"],
    ["git push --force origin main", "git push --force"],
    ["git push -f", "git push --force"],
    ["npm publish --force", "--force"],
    ["dd if=/dev/zero of=/dev/sda", "dd if="],
    ["mkfs.ext4 /dev/sdb1", "mkfs"],
    [":> /etc/passwd", "system path"],
    ["echo x > /dev/sda", "system path"],
    ["cat > /", "system path"],
  ];

  it.each(positives)("flags %j", (input, fragment) => {
    const reason = isDestructiveInput(input);
    expect(reason).not.toBeNull();
    expect(reason).toContain(fragment);
  });
});

describe("isDestructiveInput — leaves innocent input alone", () => {
  const negatives = [
    "assume the tests pass", // not "sudo"
    "let's play sudoku", // "sudo" is not a standalone word here
    "the deploy was forced through", // not "--force"
    "rm file.txt", // delete without a recursive flag
    "rm -i old.log", // interactive, no -r
    "ls -la", // listing, unrelated flags
    "git push origin main", // ordinary push
    "git status", // read-only
    "echo hello > /tmp/out.txt", // redirect to a non-system path
    "cat README.md", // benign
    "print the sum of the array", // "sum" is not "sudo"
    "run the format check", // "format" is not "mkfs"
  ];

  it.each(negatives)("passes %j", (input) => {
    expect(isDestructiveInput(input)).toBeNull();
  });
});
