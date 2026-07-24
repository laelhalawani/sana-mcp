# sana-mcp installer for Windows.
# Usage (PowerShell):  irm https://github.com/Lumen-AiApp/sana-ai-mcp/raw/main/install.ps1 | iex
# Env overrides:
#   $env:SANA_MCP_VERSION      pin a release tag (default: latest)
#   $env:SANA_MCP_INSTALL_DIR  install location (default: %LOCALAPPDATA%\sana-mcp)
#   $env:SANA_MCP_NO_REGISTER  set to "1" to skip auto-registering with AI clients
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # hide Invoke-WebRequest's noisy progress stream
$Repo = "Lumen-AiApp/sana-ai-mcp"

if ($env:SANA_MCP_VERSION) { $Version = $env:SANA_MCP_VERSION }
else { $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name }

switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { $machine = "x64" }
  "ARM64" { $machine = "arm64" }
  default { Write-Error "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"; exit 1 }
}

$asset = "sana-mcp-windows-$machine.exe"
$url = "https://github.com/$Repo/releases/download/$Version/$asset"
$installDir = if ($env:SANA_MCP_INSTALL_DIR) { $env:SANA_MCP_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "sana-mcp" }
$dest = Join-Path $installDir "sana-mcp.exe"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

Write-Host "Downloading sana-mcp $Version ($machine)..."
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
Write-Host "Installed -> $dest"

# --- add install dir to the user PATH (persistent) and this session ---
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -notcontains $installDir) {
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$userPath;$installDir" }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "Added $installDir to your PATH."
}
if (($env:Path -split ';') -notcontains $installDir) { $env:Path = "$env:Path;$installDir" }

# --- register with detected AI clients (unless opted out) ---
# The installer usually runs via `irm ... | iex`, which has no interactive
# stdin for a picker, so register with all detected clients. Re-run
# `sana-mcp install` yourself to change the selection.
if ($env:SANA_MCP_NO_REGISTER -ne "1") {
  Write-Host ""
  & $dest install --yes
}

Write-Host ""
Write-Host "Done. Next:"
Write-Host "  sana-mcp login --email you@example.com    # or just let your agent sign you in"
Write-Host "(Open a new terminal if 'sana-mcp' isn't found yet - PATH updates apply to new shells.)"
