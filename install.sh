#!/usr/bin/env sh
# sana-mcp installer - downloads the right prebuilt binary for your OS/arch.
# Usage:  curl -fsSL https://github.com/Lumen-AiApp/sana-ai-mcp/raw/main/install.sh | sh
# Env overrides: SANA_MCP_VERSION (default v0.1.0-rc1), SANA_MCP_INSTALL_DIR.
set -eu

REPO="Lumen-AiApp/sana-ai-mcp"
VERSION="${SANA_MCP_VERSION:-v0.1.0-rc1}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux*)  platform="linux" ;;
  Darwin*) platform="darwin" ;;
  *) echo "Unsupported OS: $os (on Windows use install.ps1 instead)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64)  machine="x64" ;;
  aarch64|arm64) machine="arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

asset="sana-mcp-${platform}-${machine}"
url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"

install_dir="${SANA_MCP_INSTALL_DIR:-${HOME}/.local/bin}"
dest="${install_dir}/sana-mcp"
mkdir -p "$install_dir"

echo "Downloading $url"
tmp="$(mktemp)"
curl -fsSL "$url" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "$dest"

echo "Installed sana-mcp -> $dest"
echo
echo "Next:"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "  Add '$install_dir' to your PATH, then:" ;;
esac
echo "  sana-mcp install            # detect your AI clients and register sana-mcp"
echo "  sana-mcp login --email you@example.com"
