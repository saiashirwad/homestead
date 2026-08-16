#!/usr/bin/env bash
set -euo pipefail

REPO="saiashirwad/homestead"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

# Detect OS and Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    echo "Error: Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

case "$OS" in
  darwin|linux)
    ;;
  *)
    echo "Error: Unsupported operating system: $OS" >&2
    exit 1
    ;;
esac

BINARY_NAME="homestead-${OS}-${ARCH}"
TARGET_FILE="${INSTALL_DIR}/homestead"

mkdir -p "$INSTALL_DIR"

echo "Installing Homestead (${OS}-${ARCH}) into ${INSTALL_DIR}..."

# If inside the git repository and bun is available, compile directly
if [ -f "src/cli.ts" ] && command -v bun >/dev/null 2>&1; then
  echo "Compiling from local source..."
  bun build --compile --minify ./src/cli.ts --outfile "$TARGET_FILE"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${BINARY_NAME}"
  echo "Downloading from ${DOWNLOAD_URL}..."
  curl -fsSL "$DOWNLOAD_URL" -o "$TARGET_FILE"
fi

chmod +x "$TARGET_FILE"

echo "✓ Successfully installed Homestead to ${TARGET_FILE}"

# Check if INSTALL_DIR is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "Note: ${INSTALL_DIR} is not in your PATH."
  echo "Add it to your shell configuration (e.g. ~/.zshrc or ~/.bashrc):"
  echo "  export PATH=\"\$PATH:${INSTALL_DIR}\""
fi

echo ""
"$TARGET_FILE" --version
