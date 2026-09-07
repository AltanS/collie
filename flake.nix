{
  description = "Collie's build environment: the tools a release is built and checked with.";

  # Pinned by revision, not by branch. `flake.lock` records the same revision with its hash, and
  # that lock moves ONLY in a `chore(release): x.y.z` commit — see CLAUDE.md → Versioning. A lock
  # bumped in a feature commit means the binary a bisect builds is not the binary the release built.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/c043004d1c6985732bcc1cbc5a9c9aecbbb4e0f0";

  outputs =
    { self, nixpkgs }:
    let
      # The three shipped release targets, and nothing else. `.github/workflows/release.yml`'s
      # `payload` matrix is the list this mirrors; a fourth row there is commented out and stays out
      # here too.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      # The pinned Bun. It must be at least `MIN_BUN` in cli/update-check.ts — the two are one fact
      # about which Bun this tree is built and measured on, and
      # scripts/check-flake-bun.test.ts fails when they drift apart.
      bunVersion = "1.4.1";

      # nixpkgs at the revision above ships an older Bun than MIN_BUN, so the version is pinned here
      # rather than taken from the set. Only `version` and the release archives move; the
      # derivation — autopatchelf on Linux, the ICU relink and the ad-hoc signature on Darwin — is
      # nixpkgs' and stays nixpkgs'. The hashes are the sha256 of the published archives. Those
      # patches must not reach a shipped binary, because `bun build --compile` copies the running
      # bun as its base, so the release compiles on the unpatched archive instead — `bun.src`, the
      # same URL and hash pinned here (.github/workflows/release.yml and #184).
      pinBun =
        pkgs:
        pkgs.bun.overrideAttrs (
          finalAttrs: prevAttrs: {
            version = bunVersion;
            # `src` IS overridden — it is `passthru.sources.<system>`, one attribute down. nixpkgs'
            # heuristic only looks for a literal `src`, so it warns wrongly here.
            __intentionallyOverridingVersion = true;
            passthru = prevAttrs.passthru // {
              sources = {
                "aarch64-darwin" = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-darwin-aarch64.zip";
                  hash = "sha256-2Jc86DX6eGflzHmv7m/G8a4BF6pL1fwlRv0AxRL3E4Y=";
                };
                "aarch64-linux" = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-aarch64.zip";
                  hash = "sha256-WAzndTMQjcaxC+wXITl+T1qkTpCXJtokUdSD38XlgdY=";
                };
                "x86_64-linux" = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-x64-baseline.zip";
                  hash = "sha256-qMnGc4IC4vztVV3YYKlTxWwM0Fn3UEHnAQroGjKAJkY=";
                };
              };
            };
          }
        );

      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # `packages.<system>.collie` is Collie itself, and it WRAPS the release tarball rather than
      # building it: `fetchurl` by the sha256 in packaging/nix/sources.json, which comes from that
      # release's own integrity manifest, then `autoPatchelfHook` on Linux so the binary finds an
      # interpreter on NixOS, then the whole tarball root into `$out/lib/collie` with
      # `$out/bin/collie` as a symlink into it — the Arch package's layout, because bridge/root.ts
      # resolves the install root through that symlink.
      #
      # A SOURCE BUILD IS DELIBERATELY OUT OF SCOPE. Installing the dependencies with `bun` needs
      # the network and a Nix derivation has none, so a source build would mean vendoring every
      # dependency or dropping the sandbox. The derivation and the rest of that reasoning live in
      # packaging/nix/collie.nix; `packages.<system>.bun` below is the pinned build tool, which is a
      # different thing and stays.
      packages = forEachSystem (pkgs: {
        collie = pkgs.callPackage ./packaging/nix/collie.nix { };
        bun = pinBun pkgs;
        default = pkgs.callPackage ./packaging/nix/collie.nix { };
      });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          name = "collie";

          # Five tools, and the reason each one is here:
          #   bun     — builds and runs everything (`bun run build`, `bun run lint`, `bun test`)
          #   nodejs  — what `tsc` runs under, on both sides of the double typecheck
          #   git     — what `collie update` and the preflight shell out to
          #   tmux    — a shipped multiplexer driver, exercised by scripts/collie-cli.test.sh
          #   zellij  — the other one
          #
          # Herdr is deliberately NOT pinned. It is not in nixpkgs, it is the product's peer rather
          # than one of Collie's build tools, and pinning it would turn this flake into a
          # distribution channel for something this repository does not build.
          packages = [
            (pinBun pkgs)
            pkgs.nodejs
            pkgs.git
            pkgs.tmux
            pkgs.zellij
          ];
        };
      });
    };
}
