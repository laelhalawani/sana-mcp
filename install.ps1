# sana-mcp installer for Windows.
# Usage (PowerShell):  irm https://github.com/Lumen-AiApp/sana-ai-mcp/raw/main/install.ps1 | iex
# Env overrides: $env:SANA_MCP_VERSION (default v0.1.0-rc1), $env:SANA_MCP_INSTALL_DIR.
$ErrorActionPreference = "Stop"
$Repo = "Lumen-AiApp/sana-ai-mcp"
$Version = if ($env:SANA_MCP_VERSION) { $env:SANA_MCP_VERSION } else { "v0.1.0" }

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

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing

Write-Host "Installed sana-mcp -> $dest"
Write-Host ""
Write-Host "Next:"
Write-Host "  Add '$installDir' to your PATH, then:"
Write-Host "  sana-mcp install            # detect your AI clients and register sana-mcp"
Write-Host "  sana-mcp login --email you@example.com"
