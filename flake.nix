{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/331800de5053fcebacf6813adb5db9c9dca22a0c";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-darwin" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      # Node-only server: one shell is enough.
      devShells = eachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              just
              nodejs_24
              typescript-language-server
            ];
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
            '';
          };
        }
      );
    };
}
