# Collie, as a Nix package.
#
# This derivation WRAPS the release tarball the release workflow already built and hashed. It does
# not build Collie. A SOURCE BUILD is deliberately out of scope: `bun install` needs the network and
# a Nix derivation has none, so a source build would either have to vendor every dependency or drop
# the sandbox, and neither buys anything over the binary the release already publishes and
# checksums.
#
# Every url and sha256 below comes from `./sources.json`, which `scripts/refresh-packages.ts` writes
# from `collie-<version>.manifest.json` after each release. Nothing here computes a hash.
#
# The layout is the Arch package's layout, for the same reason: `bridge/root.ts` resolves the
# install root as dirname(dirname(realpath(argv0))) and accepts it only when `herdr-plugin.toml`
# sits there. So the whole tarball root lands in `$out/lib/collie` and `$out/bin/collie` is a
# symlink into it. A bare binary on PATH would resolve its root to `$out` and serve no `web/dist`.
#
# The result classifies as a `packaged` install (ADR 0035): no `.git`, no `versions/` layout, the
# marker present, and a store path that is read-only and outside `$HOME`. `collie update` declines
# there and names the package manager instead.
{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  sources ? lib.importJSON ./sources.json,
}:

let
  # Nix system → the platform key `sources.json` uses. Three rows, because the release workflow
  # ships three payloads; macOS Intel is not built, so it is not listed here either.
  platformKeys = {
    "x86_64-linux" = "linux-x64";
    "aarch64-linux" = "linux-arm64";
    "aarch64-darwin" = "darwin-arm64";
  };

  system = stdenv.hostPlatform.system;

  key =
    platformKeys.${system}
      or (throw "collie: no release payload is published for ${system}; build from source instead");

  payload = sources.platforms.${key};
in
stdenv.mkDerivation {
  pname = "collie";
  version = sources.version;

  src = fetchurl {
    inherit (payload) url;
    # Kept in the manifest's own base-16 spelling, so the value in sources.json and the value in
    # collie-<version>.manifest.json are byte-identical and a human can compare them at a glance.
    sha256 = payload.sha256;
  };

  # The binary is a Bun single-file executable built against glibc, so on Linux it carries a
  # /lib64 interpreter and an rpath that no NixOS machine has. autoPatchelfHook rewrites both.
  # Darwin needs none of it: the release job ad-hoc signs that binary and it runs as shipped.
  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  dontConfigure = true;
  dontBuild = true;

  # The bundle a Bun single-file executable runs from is embedded in the image, and stripping it
  # produces a binary that no longer starts. Same reason the PKGBUILD sets `options=('!strip')`.
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/collie" "$out/bin"
    cp -R ./. "$out/lib/collie/"
    chmod +x "$out/lib/collie/bin/collie"
    [ -d "$out/lib/collie/scripts" ] && chmod +x "$out/lib/collie/scripts"/*.sh
    ln -s "$out/lib/collie/bin/collie" "$out/bin/collie"

    runHook postInstall
  '';

  # The binary is a Bun single-file executable: the bundle it runs from is appended to the ELF
  # image, so a hook that rewrites the file can leave something that links but no longer starts.
  # autoPatchelfHook is fine today, and this phase is what tells us the day it, or a nixpkgs
  # change under it, stops being fine. `--version` is the cheapest verb that reads the bundle.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    echo "collie --version says: $("$out/bin/collie" --version)"
    runHook postInstallCheck
  '';

  meta = {
    description = "Phone web UI for the AI agents running in your terminal, served over Tailscale";
    homepage = "https://github.com/AltanS/collie";
    license = lib.licenses.mit;
    mainProgram = "collie";
    platforms = builtins.attrNames platformKeys;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
