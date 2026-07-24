# sana-mcp installer for Windows.
# Usage (PowerShell):  irm https://github.com/Lumen-AiApp/sana-ai-mcp/raw/main/install.ps1 | iex
# Env overrides:
#   $env:SANA_MCP_VERSION      pin a release tag (default: latest)
#   $env:SANA_MCP_INSTALL_DIR  install location (default: %LOCALAPPDATA%\sana-mcp)
#   $env:SANA_MCP_YES          set to "1" for unattended install (register all detected)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # hide Invoke-* built-in progress; we draw our own
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

Write-Host "Downloading sana-mcp $Version ($machine)"

# Stream the download so we can render a progress bar with percent, size, speed, and ETA.
function Download-WithProgress($src, $out) {
  $resp = [System.Net.HttpWebRequest]::Create($src)
  $resp.UserAgent = "sana-mcp-installer"
  $r = $null; $in = $null; $fs = $null
  $buf = New-Object byte[] 1048576   # 1 MiB
  $read = 0; $sw = [System.Diagnostics.Stopwatch]::StartNew(); $lastDraw = 0
  try {
    $r = $resp.GetResponse()
    $total = $r.ContentLength
    $in = $r.GetResponseStream()
    $fs = [System.IO.File]::Create($out)
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
      $fs.Write($buf, 0, $n); $read += $n
      if ($sw.ElapsedMilliseconds - $lastDraw -ge 100 -or $read -eq $total) {
        $lastDraw = $sw.ElapsedMilliseconds
        $secs = [Math]::Max($sw.Elapsed.TotalSeconds, 0.001)
        $speed = $read / $secs
        $mb = [Math]::Round($read / 1MB, 1)
        if ($total -gt 0) {
          $pct = [int](($read / $total) * 100)
          $tmb = [Math]::Round($total / 1MB, 1)
          $eta = if ($speed -gt 0) { [TimeSpan]::FromSeconds(($total - $read) / $speed).ToString("mm\:ss") } else { "--:--" }
          $barW = 24; $fill = [int]($pct / 100 * $barW)
          $bar = ("#" * $fill) + ("-" * ($barW - $fill))
          Write-Host -NoNewline ("`r  [{0}] {1,3}%  {2}/{3} MB  {4} MB/s  ETA {5} " -f $bar, $pct, $mb, $tmb, [Math]::Round($speed/1MB,1), $eta)
        } else {
          Write-Host -NoNewline ("`r  {0} MB  {1} MB/s " -f $mb, [Math]::Round($speed/1MB,1))
        }
      }
    }
  } finally {
    if ($fs) { $fs.Close() }
    if ($in) { $in.Close() }
    if ($r) { $r.Close() }
    Write-Host ""
  }
}

$tmp = "$dest.download"
try { Download-WithProgress $url $tmp }
catch { Write-Error "Download failed from $url : $_"; if (Test-Path $tmp) { Remove-Item $tmp -Force }; exit 1 }

# --- verify SHA-256 against the published .sha256 (skip if not available) ---
$expected = $null
try { $expected = ((Invoke-WebRequest "$url.sha256" -UseBasicParsing).Content -split '\s+')[0] } catch { $expected = $null }
if ($expected) {
  $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Remove-Item $tmp -Force
    Write-Error "Checksum mismatch! expected $expected got $actual"; exit 1
  }
  Write-Host "Checksum verified."
} else {
  Write-Host "Skipping checksum verification (no published checksum)."
}
Move-Item -Force $tmp $dest
Write-Host "Installed -> $dest"

# --- add install dir to the user PATH (persistent) and this session ---
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -notcontains $installDir) {
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$userPath;$installDir" }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "Added $installDir to your PATH (restart your shell for new terminals)."
}
if (($env:Path -split ';') -notcontains $installDir) { $env:Path = "$env:Path;$installDir" }

Write-Host ""
if ($env:SANA_MCP_YES -eq "1") {
  & $dest install --yes
} elseif ([Environment]::UserInteractive) {
  # Launch the interactive configurer. iex keeps a real console, so the TUI works.
  & $dest install
} else {
  Write-Host "Installed. Run 'sana-mcp' to configure your AI clients, or set SANA_MCP_YES=1 for an unattended install."
}
