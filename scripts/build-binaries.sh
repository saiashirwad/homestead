#!/usr/bin/env bash
set -euo pipefail

DIST_DIR="dist"
mkdir -p "$DIST_DIR"

echo "Building standalone Homestead binaries..."

# Native build for current host
bun build --compile --minify ./src/cli.ts --outfile "$DIST_DIR/homestead"
echo "✓ Built $DIST_DIR/homestead"

# Cross-compilation targets
TARGETS=(
  "bun-darwin-arm64:$DIST_DIR/homestead-darwin-arm64"
  "bun-darwin-x64:$DIST_DIR/homestead-darwin-x64"
  "bun-linux-x64:$DIST_DIR/homestead-linux-x64"
  "bun-linux-arm64:$DIST_DIR/homestead-linux-arm64"
)

for TARGET_PAIR in "${TARGETS[@]}"; do
  TARGET="${TARGET_PAIR%%:*}"
  OUTFILE="${TARGET_PAIR##*:}"
  bun build --compile --minify --target="$TARGET" ./src/cli.ts --outfile "$OUTFILE"
  echo "✓ Built $OUTFILE ($TARGET)"
done

echo "All standalone binaries built successfully in $DIST_DIR/"
