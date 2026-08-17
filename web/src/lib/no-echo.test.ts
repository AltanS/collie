import { splitLines } from "./blocks";
import { parseAnsi } from "./ansi";
import { detectNoEchoPrompt } from "./no-echo";

// #103: the screen where the reply guard's evidence can never arrive. The detector decides nothing —
// the refusal is already made — so these pin the two things that matter: it recognises the prompts real
// tools actually print, and it does not claim a screen that merely talks about passwords.

const screen = (text: string) => splitLines(parseAnsi(text));

describe("detectNoEchoPrompt", () => {
  it("recognises the prompts sudo, ssh, ssh-add and gpg print", () => {
    expect(detectNoEchoPrompt(screen("$ sudo systemctl restart collie\n[sudo] password for altan:")))
      .toBe("[sudo] password for altan:");
    expect(detectNoEchoPrompt(screen("altan@host's password:"))).toBe("altan@host's password:");
    expect(detectNoEchoPrompt(screen("Enter passphrase for /home/altan/.ssh/id_ed25519:"))).toBe(
      "Enter passphrase for /home/altan/.ssh/id_ed25519:",
    );
    expect(detectNoEchoPrompt(screen("Enter passphrase:"))).toBe("Enter passphrase:");
    expect(detectNoEchoPrompt(screen("Password:"))).toBe("Password:");
    expect(detectNoEchoPrompt(screen("Password (again):"))).toBe("Password (again):");
  });

  it("reads through the trailing whitespace a blocked terminal leaves", () => {
    // The cursor sits after the prompt, so the row is padded and the rows under it are blank.
    expect(detectNoEchoPrompt(screen("[sudo] password for altan: \n\n\n"))).toBe(
      "[sudo] password for altan:",
    );
  });

  it("ignores a prompt that has scrolled up out of the live tail", () => {
    // Answered three commands ago: the terminal is not blocked on it, so offering the handoff would
    // point at the wrong thing.
    const old = "[sudo] password for altan:\nok\n$ ls\nREADME.md\n$ ";
    expect(detectNoEchoPrompt(screen(old))).toBeNull();
  });

  it("does not claim a screen that merely mentions a password", () => {
    expect(detectNoEchoPrompt(screen("I'll run sudo systemctl restart collie for you"))).toBeNull();
    expect(detectNoEchoPrompt(screen("Reading the password from the environment instead."))).toBeNull();
    // A command being composed, not a prompt: the colon is what marks the waiting cursor.
    expect(detectNoEchoPrompt(screen("$ export PASSWORD"))).toBeNull();
  });
});
