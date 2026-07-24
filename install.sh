#!/usr/bin/env sh
# sana-mcp installer - downloads the right prebuilt binary for your OS/arch,
# puts it on PATH, and registers it with your AI clients.
# Usage:  curl -fsSL https://github.com/Lumen-AiApp/sana-ai-mcp/raw/main/install.sh | sh
# Env overrides:
#   SANA_MCP_VERSION      pin a release tag (default: latest)
#   SANA_MCP_INSTALL_DIR  install location (default: ~/.local/bin)
#   SANA_MCP_NO_REGISTER  set to 1 to skip auto-registering with AI clients
set -eu

REPO="Lumen-AiApp/sana-ai-mcp"
VERSION="${SANA_MCP_VERSION:-$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')}"
[ -n "$VERSION" ] || { echo "Could not determine the latest release." >&2; exit 1; }

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

echo "Downloading sana-mcp ${VERSION} (${platform}-${machine})..."
tmp="$(mktemp)"
curl -fsSL "$url" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "$dest"
echo "Installed -> $dest"

# --- ensure install_dir is on PATH (this session + persisted for new shells) ---
case ":$PATH:" in
  *":$install_dir:"*) on_path=1 ;;
  *) on_path=0 ;;
esac
if [ "$on_path" -eq 0 ]; then
  PATH="$install_dir:$PATH"
  export PATH
  line="export PATH=\"$install_dir:\$PATH\""
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [ -f "$rc" ] && ! grep -qF "$install_dir" "$rc" 2>/dev/null; then
      printf '\n# sana-mcp\n%s\n' "$line" >> "$rc"
    fi
  done
  echo "Added $install_dir to your PATH."
fi

# --- register with detected AI clients (unless opted out) ---
if [ "${SANA_MCP_NO_REGISTER:-0}" != "1" ]; then
  echo
  if [ -t 0 ]; then
    # Run directly with a terminal: let the user pick which clients.
    "$dest" install || true
  else
    # Piped (curl | sh): no interactive input, so register all detected clients.
    "$dest" install --yes || true
  fi
fi

echo
echo "Done. Next:"
echo "  sana-mcp login --email you@example.com    # or just let your agent sign you in"
echo "(Open a new terminal if 'sana-mcp' isn't found yet - PATH updates apply to new shells.)"
