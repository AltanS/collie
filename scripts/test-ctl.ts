import { join } from "node:path";

const script =
  process.platform === "win32"
    ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dir, "collie-ctl.test.ps1")]
    : ["bash", join(import.meta.dir, "collie-ctl.test.sh")];

const child = Bun.spawn(script, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
