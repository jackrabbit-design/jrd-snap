#!/usr/bin/env bash
# Compiles standalone macOS ffmpeg binaries for bundling as Tauri sidecars
# (src-tauri/binaries/ffmpeg-<target-triple>), and installs the host-arch one
# into src-tauri/target/debug/ too so `cargo tauri dev` can find it.
#
# Why build from source instead of using Homebrew's ffmpeg directly: Homebrew's
# binary dynamically links ~60 external dylibs, which isn't redistributable.
# Rewriting those paths after the fact (dylibbundler/install_name_tool) makes
# macOS treat the binary as tampered and kill it on launch. Building from
# source with a static libx264 avoids both problems: the result only links
# against system frameworks (AVFoundation, CoreMedia, ...) and /usr/lib, which
# are present on every Mac and never need bundling.
#
# Builds both aarch64 and x86_64 by default, cross-compiling the non-host
# arch via clang's built-in -arch support (no separate toolchain or Intel Mac
# needed — Rosetta is only used here to smoke-test the cross-compiled
# binary, not to build it). Pass "aarch64" or "x86_64" as $1 to build one only.
#
# Requires: Xcode command line tools, Homebrew (for nasm, pkg-config, x264).
# Cross-compiling for x86_64 from an Apple Silicon Mac additionally requires
# Rosetta (for the post-build smoke test) — install with:
#   softwareupdate --install-rosetta
set -euo pipefail

FFMPEG_TAG="n7.1.5"
# Pinned commit on x264's "stable" branch (which has no version tags) so
# builds are reproducible instead of tracking a moving branch.
X264_TAG="b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARIES_DIR="$SCRIPT_DIR/../binaries"
DEBUG_DIR="$SCRIPT_DIR/../target/debug"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "$HOST_TRIPLE" ]; then
  echo "error: could not determine host triple via 'rustc -vV'" >&2
  exit 1
fi

# Rust/Tauri triples use "aarch64"; clang/x264's -arch flag wants "arm64" for
# the same architecture. RUST_ARCHES drives triple/filename naming (so it
# matches HOST_TRIPLE and what Tauri's externalBin/ffmpeg_path expect);
# clang_arch() maps to the value actually passed to -arch.
case "${1:-both}" in
  aarch64) RUST_ARCHES=(aarch64) ;;
  x86_64) RUST_ARCHES=(x86_64) ;;
  both) RUST_ARCHES=(aarch64 x86_64) ;;
  *) echo "usage: $0 [aarch64|x86_64]" >&2; exit 1 ;;
esac

clang_arch() {
  case "$1" in
    aarch64) echo "arm64" ;;
    *) echo "$1" ;;
  esac
}

for tool in git make nasm pkg-config; do
  command -v "$tool" >/dev/null || { echo "error: missing build tool '$tool' (try: brew install nasm pkg-config)" >&2; exit 1; }
done

# Builds a static libx264 for the given -arch value (arm64 or x86_64) and
# echoes the path to a pkg-config dir exposing ONLY that static lib (no
# .dylib), so ffmpeg's linker can't silently pick a dynamic/wrong-arch one.
build_x264() {
  local arch="$1"
  local cl_arch
  cl_arch="$(clang_arch "$arch")"
  local src="$WORK_DIR/x264-src-$arch"
  local static_only="$WORK_DIR/x264-static-only-$arch"
  # x264 has no version tags, only a moving "stable" branch, so X264_TAG is
  # a pinned commit SHA — clone --branch doesn't accept a raw SHA, so fetch
  # it explicitly instead.
  git clone --depth 1 https://code.videolan.org/videolan/x264.git "$src" >&2
  (cd "$src" && git fetch --depth 1 origin "$X264_TAG" >&2 && git checkout "$X264_TAG" >&2)

  (
    cd "$src"
    ./configure \
      --host="$cl_arch-apple-darwin" \
      --enable-static \
      --disable-cli \
      --extra-cflags="-arch $cl_arch" \
      --extra-ldflags="-arch $cl_arch" >&2
    make -j"$(sysctl -n hw.ncpu)" >&2
  )

  mkdir -p "$static_only/lib" "$static_only/pkgconfig" "$static_only/include"
  cp "$src/libx264.a" "$static_only/lib/"
  cp "$src/x264.h" "$src/x264_config.h" "$static_only/include/"
  cat > "$static_only/pkgconfig/x264.pc" <<EOF
prefix=$static_only
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: x264
Description: H.264 (MPEG4 AVC) encoder library
Version: 0.164.local
Libs: -L\${libdir} -lx264
Libs.private: -lpthread -lm -ldl
Cflags: -I\${includedir} -DX264_API_IMPORTS
EOF
  echo "$static_only/pkgconfig"
}

# Builds ffmpeg for the given -arch value, linked against the static x264
# found via $x264_pkgconfig_dir, and echoes the path to the resulting binary.
build_ffmpeg() {
  local arch="$1"
  local x264_pkgconfig_dir="$2"
  local cl_arch
  cl_arch="$(clang_arch "$arch")"
  local src="$WORK_DIR/ffmpeg-src-$arch"
  git clone --branch "$FFMPEG_TAG" --depth 1 https://github.com/FFmpeg/FFmpeg.git "$src" >&2

  local cross_flags=()
  if [ "$arch-apple-darwin" != "$HOST_TRIPLE" ]; then
    cross_flags=(--arch="$cl_arch" --target-os=darwin --enable-cross-compile --cc="clang -arch $cl_arch")
  fi

  (
    cd "$src"
    PKG_CONFIG_PATH="$x264_pkgconfig_dir" PKG_CONFIG_LIBDIR="$x264_pkgconfig_dir" ./configure \
      --prefix="$WORK_DIR/ffmpeg-out-$arch" \
      "${cross_flags[@]+"${cross_flags[@]}"}" \
      --extra-cflags="-arch $cl_arch" \
      --extra-ldflags="-arch $cl_arch" \
      --enable-gpl \
      --enable-static \
      --disable-shared \
      --enable-libx264 \
      --pkg-config-flags="--static" \
      --disable-doc \
      --disable-ffplay \
      --disable-ffprobe \
      --disable-debug \
      --disable-network \
      --disable-xlib \
      --disable-outdev=sdl2 \
      --disable-indev=xcbgrab >&2
    make -j"$(sysctl -n hw.ncpu)" >&2
  )

  echo "$src/ffmpeg"
}

for arch in "${RUST_ARCHES[@]}"; do
  triple="$arch-apple-darwin"
  echo "==> [$triple] Building static x264"
  x264_pkgconfig_dir="$(build_x264 "$arch")"

  echo "==> [$triple] Building ffmpeg $FFMPEG_TAG"
  ffmpeg_bin="$(build_ffmpeg "$arch" "$x264_pkgconfig_dir")"

  echo "==> [$triple] Verifying no non-system dylib dependencies leaked in"
  if otool -L "$ffmpeg_bin" | tail -n +2 | grep -v -E '^\s*(/System/Library/Frameworks/|/usr/lib/)'; then
    echo "error: [$triple] built binary depends on non-system libraries — see above" >&2
    exit 1
  fi

  mkdir -p "$BINARIES_DIR"
  dest="$BINARIES_DIR/ffmpeg-$triple"
  cp "$ffmpeg_bin" "$dest"
  chmod +x "$dest"
  echo "==> [$triple] Installed $dest"

  if [ "$triple" = "$HOST_TRIPLE" ] && [ -d "$DEBUG_DIR" ]; then
    cp "$dest" "$DEBUG_DIR/ffmpeg"
    echo "==> [$triple] Also copied to $DEBUG_DIR/ffmpeg for 'cargo tauri dev'"
  fi

  if [ "$triple" = "$HOST_TRIPLE" ]; then
    "$dest" -version | head -1
  elif [ "$arch" = "x86_64" ] && /usr/bin/pgrep oahd >/dev/null 2>&1; then
    arch -x86_64 "$dest" -version | head -1
  else
    echo "==> [$triple] Skipping run smoke test (not the host arch, Rosetta unavailable)"
  fi
done
