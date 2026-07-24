#!/usr/bin/env sh
# sana-mcp installer - downloads the right prebuilt binary for your OS/arch,
# puts it on PATH, then launches the interactive configurer.
# Usage:  curl -fsSL https://github.com/Lumen-AiApp/sana-ai-mcp/raw/main/install.sh | sh
# Env overrides:
#   SANA_MCP_VERSION      pin a release tag (default: latest)
#   SANA_MCP_INSTALL_DIR  install location (default: ~/.local/bin)
#   SANA_MCP_YES          set to 1 for unattended install (register all detected, no prompts)
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

echo "Downloading sana-mcp ${VERSION} (${platform}-${machine})"
tmp="$(mktemp)"
# curl shows a live progress bar (percent, size, speed, ETA) on the terminal.
if ! curl -fL --progress-bar "$url" -o "$tmp"; then
  echo "Download failed from $url" >&2
  rm -f "$tmp"
  exit 1
fi

# --- verify SHA-256 against the published .sha256 (skip if not available) ---
sum_tool=""
if command -v sha256sum >/dev/null 2>&1; then sum_tool="sha256sum"
elif command -v shasum >/dev/null 2>&1; then sum_tool="shasum -a 256"
fi
expected="$(curl -fsSL "${url}.sha256" 2>/dev/null | awk '{print $1}' || true)"
if [ -n "$expected" ] && [ -n "$sum_tool" ]; then
  actual="$($sum_tool "$tmp" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "Checksum mismatch! expected $expected got $actual" >&2
    rm -f "$tmp"
    exit 1
  fi
  echo "Checksum verified."
else
  echo "Skipping checksum verification (no published checksum or no sha256 tool)."
fi

chmod +x "$tmp"
mv "$tmp" "$dest"
echo "Installed -> $dest"

# --- ensure install_dir is on PATH (this session + persisted for new shells) ---
case ":$PATH:" in
  *":$install_dir:"*) : ;;
  *)
    PATH="$install_dir:$PATH"; export PATH
    line="export PATH=\"$install_dir:\$PATH\""
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      if [ -f "$rc" ] && ! grep -qF "$install_dir" "$rc" 2>/dev/null; then
        printf '\n# sana-mcp\n%s\n' "$line" >> "$rc"
      fi
    done
    echo "Added $install_dir to your PATH (restart your shell for new terminals)."
    ;;
esac

echo
# Can we reach a real terminal? (When run via `curl | sh`, our own stdin is the
# pipe, so the interactive configurer must talk to /dev/tty directly.)
if { true >/dev/tty; } 2>/dev/null; then
  have_tty=1
else
  have_tty=0
fi

if [ "${SANA_MCP_YES:-0}" = "1" ]; then
  # Unattended: register with all detected clients, no prompts.
  "$dest" install --yes || true
elif [ "$have_tty" = "1" ]; then
  # Hand the terminal to the interactive configurer.
  "$dest" install < /dev/tty > /dev/tty 2>&1 || true
else
  # No terminal (piped/headless): never silently edit configs - tell the user.
  echo "Installed. Run 'sana-mcp' to choose which AI clients to configure and to sign in,"
  echo "or re-run with SANA_MCP_YES=1 to register with all detected clients."
fi
