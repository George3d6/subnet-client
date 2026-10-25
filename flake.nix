{
  description = "subnet: end to end encrypted Matrix client for humans and agents";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    crypto_version = "0.6.6";
    crypto_libs = {
      x86_64-linux = {
        file = "matrix-sdk-crypto.linux-x64-gnu.node";
        hash = "sha256-rrIQKaxrspzQZJP2exmlp1s9A3Ghq0Uv5Z94JJNQ8Pc=";
      };
      aarch64-linux = {
        file = "matrix-sdk-crypto.linux-arm64-gnu.node";
        hash = "sha256-xDw0fzl4buny0Rta4wiNGCwagWNvK2jcIpf+Zxa+KJE=";
      };
      x86_64-darwin = {
        file = "matrix-sdk-crypto.darwin-x64.node";
        hash = "sha256-SiKjUemIue0ekGILNHTldjJc5Sh/YjNRtrLpz68HjCw=";
      };
      aarch64-darwin = {
        file = "matrix-sdk-crypto.darwin-arm64.node";
        hash = "sha256-mdx9kKqDDZttlrzaI1ic4Pty0Q+E7ER8nSQZN/7obZ8=";
      };
    };
    systems = builtins.attrNames crypto_libs;
    for_all = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    subnet = pkgs: let
      crypto_lib = crypto_libs.${pkgs.stdenv.hostPlatform.system};
      crypto_native = pkgs.fetchurl {
        url = "https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/releases/download/v${crypto_version}/${crypto_lib.file}";
        inherit (crypto_lib) hash;
      };
    in
      pkgs.buildNpmPackage {
        pname = "subnet-client";
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
        src = ./.;
        nodejs = pkgs.nodejs_24;
        npmDepsHash = "sha256-/2R0xW/jaye3fPpCuTrtO226ZVvHOnqHktDauiUtysY=";
        npmRebuildFlags = ["--ignore-scripts"];
        dontNpmBuild = true;
        nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [pkgs.autoPatchelfHook];
        buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [pkgs.stdenv.cc.cc.lib];
        postInstall = ''
          crypto=$out/lib/node_modules/subnet-client/node_modules/@matrix-org/matrix-sdk-crypto-nodejs
          install -m 755 ${crypto_native} $crypto/${crypto_lib.file}
          echo -n ${crypto_version} > $crypto/${crypto_lib.file}.version
        '';
        meta = {
          description = "End to end encrypted Matrix client for humans and agents";
          homepage = "https://github.com/vanadium-xyz/subnet-client";
          license = pkgs.lib.licenses.mit;
          mainProgram = "subnet";
          platforms = systems;
        };
      };
  in {
    packages = for_all (pkgs: rec {
      subnet-client = subnet pkgs;
      default = subnet-client;
    });

    overlays.default = final: _: {subnet-client = subnet final;};

    apps = for_all (pkgs: {
      default = {
        type = "app";
        program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/subnet";
      };
    });

    devShells = for_all (pkgs: {
      default = pkgs.mkShell {packages = [pkgs.nodejs_24];};
    });
  };
}
