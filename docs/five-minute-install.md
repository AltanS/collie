# Install in five minutes

This guide sets up Collie on your phone. Install three tools on your computer, start Collie,
and pair your phone.

It uses the recommended setup: Tailscale as the front door, Herdr as the multiplexer, and the
install script. For other setups, see [Install](install.md).

> **Note.** Collie gives remote shell access to your machine by design. Read
> [Security](security.md) before you install it.

## What you need

- A Linux or macOS computer (the host). A Mac needs Apple Silicon
  and macOS 13 or newer.
- An iPhone or an Android phone.
- A Tailscale account.

## 1. Install Tailscale

Tailscale links the host and your phone on one private network, your tailnet. Collie is reachable
only on that network.

On a Linux host:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --operator=$USER
```

`--operator=$USER` lets your user run `tailscale serve`, which Collie needs in step 4.

On a Mac, install Tailscale from [tailscale.com/download](https://tailscale.com/download)
and sign in. Install the `tailscale` command from the app settings. Collie calls it.

Next, set up the tailnet and the phone:

1. Open the [admin console](https://login.tailscale.com/admin/dns) and select **Enable HTTPS**.
   Collie requires it.
2. Install the Tailscale app on your phone. Sign in with the same account.

## 2. Install Herdr

Herdr keeps terminal panes and coding agents running on the host when you disconnect.
Collie shows those panes on your phone.

```bash
curl -fsSL https://herdr.dev/install.sh | sh    # or: brew install herdr
herdr
```

Herdr opens a pane. Start your agent there, for example `claude`. Leave Herdr running.

## 3. Install Collie

Open a second terminal on the host and run the install script:

```bash
curl -fsSL https://colliepwa.dev/install.sh | sh
```

The script saves the `collie` binary to `~/.local/bin`. It does not use `sudo`. If your shell
cannot find `collie`, add `~/.local/bin` to your PATH. [Standalone](install.md#standalone)
covers the details.

## 4. Start Collie

```bash
COLLIE_MUX=herdr collie start
```

`start` runs Collie in the background and exposes it on your tailnet with
`tailscale serve`. It saves `herdr` as the multiplexer. Future runs need only `collie start`. When
ready, it prints **Collie is running** and shows your URL on the `tailnet` line, for example
`https://myhost.tail1234.ts.net`.

On a remote Linux host reached by SSH, keep Collie running after logout:

```bash
loginctl enable-linger $USER
```

## 5. Put Collie on your phone and pair it

```bash
collie qr
```

1. Scan the QR code with your phone camera to open Collie in the browser.
2. Add Collie to your home screen so it opens full screen like an app.
   - **iPhone:** in Safari, tap **Share**, tap **Add to Home Screen**, and tap **Add**.
   - **Android:** in Chrome, open Collie **Settings** and tap **Install** on the top card.
3. Open Collie from the new icon.
4. Run `collie pair` on the host to print an 8-character code, valid for 10 minutes.
5. In Collie, open **Settings**, then **System**, and find **Paired devices**.
6. Enter the code and a name, for example `my phone`, and tap **Pair this device**.

Pair inside the home screen app, not in the browser tab. On an iPhone, the home screen app keeps
its own storage, separate from Safari. A pairing made in Safari does not carry over.

Once one device is paired, only paired devices can type into your panes. Until then, any device on
your tailnet can type. Pair right after `start`. On a tailnet shared with other people, also
set `COLLIE_TRUSTED_USER` ([Configure](configure.md#configure)).

The dashboard lists your Herdr panes. Panes waiting for input appear first. Tap a pane to
view output and reply.

## Next steps

- [Claude Code in tmux or Herdr, on your phone](claude-code-on-your-phone.md) walks through a full
  day of use with Claude Code.
- [Web Push](voice-and-push.md#web-push-optional) adds notifications when an agent needs input.
- [Configure](configure.md#configure) documents how to restrict Collie to your tailnet user with
  `COLLIE_TRUSTED_USER`.
- [Troubleshooting](troubleshooting.md#troubleshooting) covers common errors.

---

[← back to the README](../README.md)
