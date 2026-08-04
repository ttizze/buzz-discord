{
  description = "Buzzcode reproducible development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        linuxTauriLibraries = with pkgs; lib.optionals stdenv.isLinux [
          alsa-lib
          at-spi2-atk
          atkmm
          cairo
          gdk-pixbuf
          glib
          gtk3
          libsoup_3
          librsvg
          openssl
          pango
          webkitgtk_4_1
        ];
      in {
        devShells.default = pkgs.mkShell ({
          packages = with pkgs; [
            cargo
            cargo-tauri
            clippy
            curl
            jq
            just
            nodejs_24
            openssl
            pkg-config
            playwright-driver.browsers
            pnpm
            postgresql_17
            rustc
            rustfmt
          ] ++ linuxTauriLibraries;

          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          RUST_BACKTRACE = "1";

          shellHook = ''
            echo "Buzzcode development shell (${system})"
            echo "Run 'just setup' once, then 'just test'."
          '';
        } // pkgs.lib.optionalAttrs pkgs.stdenv.isDarwin {
          MACOSX_DEPLOYMENT_TARGET = "14.0";
        });
      });
}
