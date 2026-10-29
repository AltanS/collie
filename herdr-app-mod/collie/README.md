# Collie panel for herdr-app

A small panel inside [herdr-app](https://herdr.dev) for Collie, the phone app for your agents. It
does what the Herdr plugin's actions did, and it pairs a phone.

**This panel is experimental.** It passes `herdr-app check`, but it has not yet run in a live
herdr-app window. Collie does not install it: the installer, `collie start` and `collie update`
never copy it. You install it by hand, by copying this folder (see Install below). Its behaviour may
change in any release.

What it does:

- It shows whether the Collie bridge runs, its version, its mode, its port, its service and how
  many devices are paired.
- It shows the URL your phone opens. You can select and copy it, or open it in your browser.
- **Start**, **Stop** and **Restart** run `collie start`, `collie stop` and `collie restart`. Stop
  asks for a second click, because it cuts the phone off.
- **Test push** runs `collie push-test`, which sends one notification to every subscribed phone.
- **Pair a phone** makes a single-use pairing code. The panel shows the code and its QR code. Scan
  the QR code with the phone's camera, or open Collie on the phone, go to Settings and enter the
  code. The code stops working after 10 minutes.

## What it needs

- Collie 1.25.0 or newer, with `collie` on your PATH. The panel reads `collie status --json` and
  `collie pair --json`. An older Collie shows "This Collie is too old for the panel": run
  `collie update`.
- herdr-app 0.1.7 or newer.

## Install

Copy this folder into herdr-app's mods folder, then check it:

```sh
git clone --depth 1 https://github.com/AltanS/collie /tmp/collie-mod
cp -r /tmp/collie-mod/herdr-app-mod/collie ~/.config/herdr-app/mods/collie
herdr-app check ~/.config/herdr-app/mods/collie
```

Or ask the agent in your herdr-app terminal: "Install the Collie mod from
github.com/AltanS/collie, folder herdr-app-mod/collie, into my herdr-app mods, and check it."

The first time herdr-app sees the folder, it docks the panel on the right of the window you see.
To open it as a window instead, run **mod.open** from the command palette with the name `collie`.
To remove the panel, delete `~/.config/herdr-app/mods/collie`.

## Settings

- **Another Collie instance.** On a computer with more than one Collie, give the panel's block the
  prop `{ "instance": "next" }` in your layout. Without it, the panel watches the default
  instance. Named instances work on Linux and macOS.
- **Keys.** The panel takes `collie.start`, `collie.stop`, `collie.restart`, `collie.pair` and
  `collie.open` from `keys.json`, for example `"global": { "ctrl-alt-shift-p": "collie.pair" }`.
  A key reaches the panel only while it shows.

## What it runs on your computer

A mod runs programs as you. This one runs only these:

- `collie status --json` every 15 seconds, and once after each button.
- A read of the bridge's own `/api/health` on its local address, for the version and the mode.
- `collie start`, `collie stop`, `collie restart`, `collie push-test` and `collie pair --json`,
  each only when you click its button or press its key.
- `env COLLIE_INSTANCE=<name> collie ...` instead of `collie ...` when you set an instance.
- `xdg-open`, `open` (macOS) or `rundll32` (Windows) to open the phone URL in your browser.

The panel writes no file. The pairing code stays in the panel's memory until it expires or you
click **Hide code**. Collie itself keeps only a hash of it.

## What it does not do yet

The panel does not focus panes, rename tabs or spaces, close tabs or make spaces for Collie. Those
need a channel between Collie and the panel that is not built yet.
