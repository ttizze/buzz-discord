{
  description = "Pinned Claude ACP runtime for the Buzz Discord VPS agent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in {
      packages.${system} = rec {
        claude-agent-acp = pkgs.buildNpmPackage {
          pname = "buzz-discord-claude-agent-acp";
          version = "0.64.0";
          src = ./.;

          npmDepsHash = "sha256-bqeUkndUNe1ZBUofNxHZw2F9ZKn1bxL96oXF9u0orw4=";
          dontNpmBuild = true;
          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/libexec" "$out/bin"
            cp -R node_modules "$out/libexec/node_modules"
            makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/claude-agent-acp" \
              --add-flags "$out/libexec/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"

            runHook postInstall
          '';
        };

        default = claude-agent-acp;
      };
    };
}
