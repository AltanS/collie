using System;
using System.Diagnostics;
using System.IO;

internal static class CollieAction
{
    private static int Main(string[] args)
    {
        var executable = Process.GetCurrentProcess().MainModule.FileName;
        var root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(executable), ".."));
        if (root.StartsWith(@"\\?\", StringComparison.Ordinal)) root = root.Substring(4);

        var start = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
            Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" +
                Path.Combine(root, "scripts", "collie-ctl.ps1") + "\" " + string.Join(" ", args),
            UseShellExecute = false,
        };
        using (var child = Process.Start(start))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
