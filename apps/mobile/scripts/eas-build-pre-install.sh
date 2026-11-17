#!/usr/bin/env bash
# EAS Build runs this before it installs dependencies (`eas-build-pre-install` in package.json). The SSH library's
# Rust archive is not in git, and its pod links it, so it has to exist before `pod install`. EAS's Mac images ship
# no Rust, so it is installed first; the library's rust-toolchain.toml names the toolchain.
set -euo pipefail

if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
fi
library="$(cd "$(dirname "$0")/../../../packages/react-native-ssh" && pwd)"
# EAS builds a simulator app for Intel Macs too (its destination is the generic simulator), and CocoaPods links no
# slice that lacks one of the build's architectures. The library's script adds that slice when the target is there.
(cd "$library/rust" && rustup target add x86_64-apple-ios)
bash "$library/scripts/build-rust-ios.sh"
