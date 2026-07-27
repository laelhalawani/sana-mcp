# Install the latest sana-mcp release:
#   irm https://github.com/laelhalawani/sana-mcp/releases/latest/download/install.ps1 | iex
# Pin a release:
#   Set $env:SANA_MCP_VERSION to an exact tag, then run the command above.
& {
$CallerLastExitCodeVariable = Get-Variable -Name LASTEXITCODE -Scope 1 -ErrorAction SilentlyContinue
$CallerHadLastExitCode = $null -ne $CallerLastExitCodeVariable
$CallerLastExitCode = if ($CallerHadLastExitCode) {
  $CallerLastExitCodeVariable.Value
} else {
  $null
}
$GlobalLastExitCodeVariable = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
$GlobalHadLastExitCode = $null -ne $GlobalLastExitCodeVariable
$GlobalLastExitCode = if ($GlobalHadLastExitCode) {
  $GlobalLastExitCodeVariable.Value
} else {
  $null
}
$CallerAndGlobalLastExitCodeAreSame =
  $CallerHadLastExitCode -and
  $GlobalHadLastExitCode -and
  [object]::ReferenceEquals(
    $CallerLastExitCodeVariable,
    $GlobalLastExitCodeVariable
  )
try {
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$PSNativeCommandUseErrorActionPreference = $false
$Repo = "laelhalawani/sana-mcp"
$TempDir = $null
$StagedBinary = $null
$InstallLock = $null
$InstallLockHandle = $null
$PathLock = $null
$PathLockHandle = $null
$Destination = $null
$ReceiptPath = $null
$TransactionActive = $false
$Committed = $false
$OldPresent = $false
$LegacyInstall = $false
$OldWasRunning = $false
$ShouldRunAfterInstall = $false
$PathChanged = $false
$OldUserPath = $null
$PreserveTemp = $false
$LockAcquired = $false
$PathLockAcquired = $false
$OldBinaryBackup = $null
$OldReceiptBackup = $null
$OldBinaryDigest = $null
$OldReceiptDigest = $null
$RetiredBinary = $null
$RetiredReceipt = $null
$RetiredBinarySafeToDelete = $false
$RetiredReceiptSafeToDelete = $false
$NewPathManaged = $false
$StagedReceipt = $null
$NewReceiptDigest = $null
$WrittenUserPath = $null
$RetainNewRuntime = $false
$RuntimeStateTouched = $false
$InstallFailure = $null
$CleanupErrors = @()
$IncompatibleInstall = $false
$IncompatibleReceiptConfirmed = $false
$IncompatibleStateReset = $false
$IncompatibleDigest = $null
$IncompatibleResetJournal = $null
$IncompatibleResetPrepared = $false
$StateRecoveryIncomplete = $false

function Assert-ReleaseTag([string] $Tag) {
  if ($Tag -cnotmatch '\Av(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?\z') {
    throw "Release metadata contains an invalid tag."
  }
}

function Format-ExecutableCommand([string] $Executable) {
  if ([string]::IsNullOrWhiteSpace($Executable)) {
    throw "The installed executable path is unavailable."
  }
  return "& '" + $Executable.Replace("'", "''") + "'"
}

function Format-InstallCommand(
  [string] $Executable,
  [switch] $Yes
) {
  $Command = (Format-ExecutableCommand $Executable) + " install"
  if ($Yes) {
    return "$Command --yes"
  }
  return $Command
}

function Invoke-PostInstallConfigurer(
  [string] $Executable,
  [switch] $Yes
) {
  $Arguments = @("install")
  if ($Yes) {
    $Arguments += "--yes"
  }
  try {
    $Configurer = Start-Process `
      -FilePath $Executable `
      -ArgumentList $Arguments `
      -NoNewWindow `
      -Wait `
      -PassThru
    if ($Configurer.ExitCode -ne 0) {
      return [pscustomobject] @{
        state = "exited"
        exitCode = $Configurer.ExitCode
      }
    }
    return [pscustomobject] @{
      state = "success"
    }
  } catch {
    return [pscustomobject] @{
      state = "launch-failed"
      message = $_.Exception.Message
    }
  }
}

function Publish-CurrentProcessPath(
  [string] $InstallDirectory,
  [string] $Executable
) {
  $OriginalProcessPath = $env:Path
  try {
    $ProcessEntries = if ([string]::IsNullOrEmpty($OriginalProcessPath)) {
      @()
    } else {
      @($OriginalProcessPath -split ";")
    }
    $InstallDirectoryPresent = @(
      $ProcessEntries | Where-Object {
        [string]::Equals(
          $_,
          $InstallDirectory,
          [StringComparison]::OrdinalIgnoreCase
        )
      }
    ).Count -gt 0
    if (-not $InstallDirectoryPresent) {
      $env:Path = if ([string]::IsNullOrEmpty($OriginalProcessPath)) {
        $InstallDirectory
      } else {
        "$InstallDirectory;$OriginalProcessPath"
      }
    }

    $Resolved = @(Get-Command sana-mcp -CommandType Application -ErrorAction Stop)
    if ($Resolved.Count -eq 0 -or
        -not [string]::Equals(
          [IO.Path]::GetFullPath($Resolved[0].Source),
          [IO.Path]::GetFullPath($Executable),
          [StringComparison]::OrdinalIgnoreCase
        )) {
      throw "Bare sana-mcp did not resolve to the installed application."
    }
    $VersionOutput = @(& sana-mcp --version 2>&1)
    if ($LASTEXITCODE -ne 0) {
      throw "Bare sana-mcp --version exited with code $LASTEXITCODE."
    }
    return $true
  } catch {
    $env:Path = $OriginalProcessPath
    Write-Host "Close and reopen PowerShell before running sana-mcp."
    Write-Host "Run: $(Format-ExecutableCommand $Executable)"
    return $false
  }
}

function Get-ShouldRunAfterInstall(
  [bool] $ExistingReceiptBacked,
  [bool] $OldRunning,
  [bool] $UpdaterHandoff,
  [bool] $IncompatibleReplacement
) {
  return $OldRunning -or (
    $ExistingReceiptBacked -and
    -not $UpdaterHandoff -and
    -not $IncompatibleReplacement
  )
}

function Open-HttpsResponse([string] $Source) {
  $Current = [Uri] $Source
  for ($Redirects = 0; $Redirects -le 5; $Redirects++) {
    if ($Current.Scheme -ne [Uri]::UriSchemeHttps) {
      throw "Release download refused a non-HTTPS URL."
    }
    $Request = [System.Net.HttpWebRequest]::CreateHttp($Current)
    $Request.AllowAutoRedirect = $false
    $Request.UserAgent = "sana-mcp-installer/1"
    $Request.Timeout = 15000
    $Request.ReadWriteTimeout = 300000
    try {
      $Response = [System.Net.HttpWebResponse] $Request.GetResponse()
    } catch [System.Net.WebException] {
      if ($null -ne $_.Exception.Response) {
        $_.Exception.Response.Dispose()
      }
      throw
    }
    $Status = [int] $Response.StatusCode
    if ($Status -ge 300 -and $Status -lt 400) {
      $Location = $Response.Headers["Location"]
      $Response.Dispose()
      if ([string]::IsNullOrWhiteSpace($Location)) {
        throw "Release redirect did not provide a destination."
      }
      if ($Redirects -eq 5) {
        throw "Release download exceeded five redirects."
      }
      $Current = [Uri]::new($Current, $Location)
      continue
    }
    if ($Status -ne 200) {
      $Response.Dispose()
      throw "Release download returned HTTP $Status."
    }
    return $Response
  }
  throw "Release download exceeded five redirects."
}

function Download-Https(
  [string] $Source,
  [string] $Destination,
  [switch] $ShowProgress
) {
  $Response = Open-HttpsResponse $Source
  $InputStream = $null
  $OutputStream = $null
  $ProgressCompleted = $false
  try {
    $InputStream = $Response.GetResponseStream()
    $OutputStream = [System.IO.File]::Create($Destination)
    $Buffer = New-Object byte[] 1048576
    [long] $ReadTotal = 0
    $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    [long] $LastDraw = 0
    while (($Count = $InputStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
      if ($Stopwatch.Elapsed.TotalSeconds -gt 600) {
        throw "Release download exceeded ten minutes."
      }
      $OutputStream.Write($Buffer, 0, $Count)
      $ReadTotal += $Count
      if ($ShowProgress -and ($Stopwatch.ElapsedMilliseconds - $LastDraw -ge 100)) {
        $LastDraw = $Stopwatch.ElapsedMilliseconds
        Write-Host -NoNewline (
          Format-DownloadProgress `
            $ReadTotal `
            $Response.ContentLength `
            $Stopwatch.Elapsed.TotalSeconds
        )
      }
    }
    if ($ShowProgress) {
      Write-Host (
        Format-DownloadProgress `
          $ReadTotal `
          $Response.ContentLength `
          $Stopwatch.Elapsed.TotalSeconds
      )
      $ProgressCompleted = $true
    }
  } finally {
    if ($ShowProgress -and -not $ProgressCompleted) {
      Write-Host ""
    }
    if ($null -ne $OutputStream) { $OutputStream.Dispose() }
    if ($null -ne $InputStream) { $InputStream.Dispose() }
    $Response.Dispose()
  }
}

function Format-DownloadProgress(
  [long] $BytesRead,
  [long] $TotalBytes,
  [double] $ElapsedSeconds
) {
  $Seconds = [Math]::Max($ElapsedSeconds, 0.001)
  $SpeedBytes = $BytesRead / $Seconds
  $ReadMegabytes = [Math]::Round($BytesRead / 1MB, 1)
  $SpeedMegabytes = [Math]::Round($SpeedBytes / 1MB, 1)
  $InvariantCulture = [Globalization.CultureInfo]::InvariantCulture
  $ReadMegabytesText =
    $ReadMegabytes.ToString("0.#", $InvariantCulture)
  $SpeedMegabytesText =
    $SpeedMegabytes.ToString("0.#", $InvariantCulture)
  if ($TotalBytes -le 0) {
    return (
      "`r  {0} MB  {1} MB/s " -f
        $ReadMegabytesText,
        $SpeedMegabytesText
    )
  }

  $Ratio = [Math]::Min(
    1.0,
    [Math]::Max(0.0, $BytesRead / [double] $TotalBytes)
  )
  $Percent = [int] [Math]::Floor($Ratio * 100)
  $TotalMegabytes = [Math]::Round($TotalBytes / 1MB, 1)
  $TotalMegabytesText =
    $TotalMegabytes.ToString("0.#", $InvariantCulture)
  $ReadMegabytesText =
    $ReadMegabytesText.PadLeft($TotalMegabytesText.Length)
  $RemainingSeconds = if ($SpeedBytes -gt 0) {
    [Math]::Max(0.0, ($TotalBytes - $BytesRead) / $SpeedBytes)
  } else {
    0.0
  }
  $Eta = [TimeSpan]::FromSeconds($RemainingSeconds).ToString("mm\:ss")
  $BarWidth = 24
  $Fill = [int] [Math]::Floor($Ratio * $BarWidth)
  $Bar = ("#" * $Fill) + ("-" * ($BarWidth - $Fill))
  return (
    "`r  [{0}] {1,3}%  {2}/{3} MB  {4} MB/s  ETA {5} " -f
      $Bar,
      $Percent,
      $ReadMegabytesText,
      $TotalMegabytesText,
      $SpeedMegabytesText,
      $Eta
  )
}

function Read-Properties(
  [string] $File,
  [string[]] $AllowedKeys
) {
  $Values = @{}
  foreach ($Line in [System.IO.File]::ReadAllLines($File)) {
    if ($Line.Length -eq 0) { continue }
    $Separator = $Line.IndexOf("=")
    if ($Separator -le 0) { throw "Release metadata is malformed." }
    $Key = $Line.Substring(0, $Separator)
    $Value = $Line.Substring($Separator + 1)
    if ($Key -notmatch '^[A-Za-z0-9]+$' -or $AllowedKeys -cnotcontains $Key) {
      throw "Release metadata contains an unknown key."
    }
    if ($Values.ContainsKey($Key)) {
      throw "Release metadata repeats $Key."
    }
    if ($Value -notmatch '^[A-Za-z0-9._+-]+$') {
      throw "Release metadata contains an invalid $Key."
    }
    $Values[$Key] = $Value
  }
  return $Values
}

function Read-ReleaseProperties([string] $File, [string] $ExpectedTarget) {
  $Allowed = @(
    "format", "manifestVersion", "manifestSha256", "packageVersion",
    "releaseTag", "sourceCommit", "installerProtocol", "lifecycleProtocol", "inspectProtocol",
    "stateCompatibility", "semanticCapability", "installerAssetName",
    "installerSha256", "target", "libc", "assetName",
    "checksumFileName", "sha256"
  )
  $Values = Read-Properties $File $Allowed
  $Required = @(
    "format", "manifestVersion", "manifestSha256", "packageVersion",
    "releaseTag", "sourceCommit", "installerProtocol", "lifecycleProtocol", "inspectProtocol",
    "stateCompatibility", "semanticCapability", "installerAssetName",
    "installerSha256", "target", "assetName", "checksumFileName", "sha256"
  )
  foreach ($Key in $Required) {
    if (-not $Values.ContainsKey($Key)) { throw "Release metadata is missing $Key." }
  }
  if ($Values["format"] -cne "sana-mcp-release-v1") { throw "Unsupported release metadata format." }
  if ($Values["manifestVersion"] -cne "1") { throw "Unsupported release manifest version." }
  if ($Values["installerProtocol"] -cne "1") { throw "Unsupported installer protocol." }
  if ($Values["lifecycleProtocol"] -cne "1") { throw "Unsupported lifecycle protocol." }
  if ($Values["inspectProtocol"] -cne "1") { throw "Unsupported inspect protocol." }
  if ($Values["stateCompatibility"] -cnotmatch '^[1-9][0-9]*$') {
    throw "Release state compatibility is invalid."
  }
  if ($Values["semanticCapability"] -cne "keyword") { throw "Unsupported binary capability." }
  if ($Values["installerAssetName"] -cne "install.ps1" -or
      $Values["installerSha256"] -cnotmatch '^[a-f0-9]{64}$') {
    throw "Release metadata does not bind the Windows installer."
  }
  if ($Values["target"] -cne $ExpectedTarget) { throw "Release metadata target does not match this system." }
  if ($Values.ContainsKey("libc")) { throw "Windows release metadata must not declare libc." }
  if ($Values["releaseTag"] -cne "v$($Values["packageVersion"])") {
    throw "Release version and tag do not match."
  }
  Assert-ReleaseTag $Values["releaseTag"]
  if ($Values["sourceCommit"] -cnotmatch '^[a-f0-9]{40}$') {
    throw "Release source commit is invalid."
  }
  if ($Values["assetName"] -cne "sana-mcp-windows-x64.exe") {
    throw "Release metadata asset name does not match its target."
  }
  if ($Values["checksumFileName"] -cne "$($Values["assetName"]).sha256") {
    throw "Release metadata checksum filename does not match its binary."
  }
  if ($Values["manifestSha256"] -cnotmatch '^[a-f0-9]{64}$' -or
      $Values["sha256"] -cnotmatch '^[a-f0-9]{64}$') {
    throw "Release metadata contains an invalid SHA-256."
  }
  if ($Values["assetName"] -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or
      $Values["checksumFileName"] -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw "Release metadata contains an unsafe filename."
  }
  return $Values
}

function Read-Checksum([string] $File, [string] $ExpectedName) {
  $Body = [System.IO.File]::ReadAllText($File).TrimEnd("`r", "`n")
  $Match = [regex]::Match($Body, '^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$')
  if (-not $Match.Success) { throw "Checksum file for $ExpectedName is malformed." }
  if ($Match.Groups[2].Value -cne $ExpectedName) {
    throw "Checksum file names the wrong asset."
  }
  return $Match.Groups[1].Value
}

function Get-Sha256([string] $File) {
  return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RetiredInstallerFileName(
  [string] $Destination,
  [string] $Token
) {
  if ($Token -cnotmatch '^[a-f0-9]{32}$') {
    throw "The retired installer file token is invalid."
  }
  $DestinationName = [IO.Path]::GetFileName($Destination)
  if ([IO.Path]::GetExtension($DestinationName) -ceq ".exe") {
    return (
      "." + [IO.Path]::GetFileNameWithoutExtension($DestinationName) +
      "-retired-" + $Token + ".exe"
    )
  }
  $Prefix = if ($DestinationName.StartsWith(".")) { "" } else { "." }
  return $Prefix + $DestinationName + "-retired-" + $Token
}

function Publish-InstallerFile(
  [string] $Source,
  [string] $Destination,
  [string] $ExpectedSourceSha256,
  [AllowNull()] [string] $ExpectedDestinationSha256,
  [ref] $RetiredPath
) {
  if ((Get-Sha256 $Source) -cne $ExpectedSourceSha256) {
    throw "The staged file changed before publication."
  }
  $SourceParent = [IO.Path]::GetFullPath((Split-Path -Parent $Source))
  $DestinationParent =
    [IO.Path]::GetFullPath((Split-Path -Parent $Destination))
  if (-not [string]::Equals(
      $SourceParent,
      $DestinationParent,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Installer publication requires a same-directory staged file."
  }
  $DestinationExists =
    Test-Path -LiteralPath $Destination -PathType Leaf
  if ($DestinationExists) {
    if ([string]::IsNullOrEmpty($ExpectedDestinationSha256) -or
        (Get-Sha256 $Destination) -cne $ExpectedDestinationSha256) {
      throw "The installed file changed before publication."
    }
    $RetiredName = Get-RetiredInstallerFileName `
      $Destination `
      ([Guid]::NewGuid().ToString("N"))
    $RetiredPath.Value = Join-Path $DestinationParent $RetiredName
    Move-Item -LiteralPath $Destination `
      -Destination $RetiredPath.Value
  } elseif (-not [string]::IsNullOrEmpty($ExpectedDestinationSha256)) {
    throw "The installed file disappeared before publication."
  }
  try {
    Move-Item -LiteralPath $Source -Destination $Destination
    if ((Get-Sha256 $Destination) -cne $ExpectedSourceSha256) {
      throw "The published file checksum is incorrect."
    }
  } catch {
    if (-not [string]::IsNullOrEmpty($RetiredPath.Value) -and
        (Test-Path -LiteralPath $RetiredPath.Value -PathType Leaf) -and
        -not (Test-Path -LiteralPath $Destination)) {
      Move-Item -LiteralPath $RetiredPath.Value `
        -Destination $Destination
      $RetiredPath.Value = $null
    }
    throw
  }
}

function Restore-InstallerFileState(
  [string] $Destination,
  [AllowNull()] [string] $PreviousFile,
  [AllowNull()] [string] $PreviousSha256,
  [AllowNull()] [string] $ReplacementSha256,
  [string] $Label
) {
  $CurrentSha256 = if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    Get-Sha256 $Destination
  } else {
    $null
  }
  if (-not [string]::IsNullOrEmpty($PreviousSha256)) {
    if ($CurrentSha256 -ceq $PreviousSha256) {
      return
    }
    if ($null -ne $CurrentSha256 -and
        $CurrentSha256 -cne $ReplacementSha256) {
      throw "$Label contains unexpected bytes; recovery files were retained."
    }
    if ([string]::IsNullOrEmpty($PreviousFile) -or
        -not (Test-Path -LiteralPath $PreviousFile -PathType Leaf) -or
        (Get-Sha256 $PreviousFile) -cne $PreviousSha256) {
      throw "The authoritative previous $Label backup is unavailable."
    }
    $Stage = Join-Path (Split-Path -Parent $Destination) (
      "." + [IO.Path]::GetFileName($Destination) + "-restore-" +
      [Guid]::NewGuid().ToString("N")
    )
    $Retired = $null
    try {
      Copy-Item -LiteralPath $PreviousFile -Destination $Stage
      Publish-InstallerFile `
        $Stage `
        $Destination `
        $PreviousSha256 `
        $CurrentSha256 `
        ([ref] $Retired)
      if ($null -ne $Retired -and
          (Test-Path -LiteralPath $Retired -PathType Leaf)) {
        if ([IO.Path]::GetExtension($Destination) -ceq ".exe") {
          Stop-CanonicalRuntimeProcesses $Retired
        }
        Assert-NotReparse $Retired "Retired $Label"
        if (-not (Test-Path -LiteralPath $Retired -PathType Leaf) -or
            (Get-Sha256 $Retired) -cne $CurrentSha256) {
          throw "The retired $Label changed before rollback cleanup."
        }
        Remove-Item -LiteralPath $Retired -Force
      }
    } finally {
      if (Test-Path -LiteralPath $Stage) {
        Remove-Item -LiteralPath $Stage -Force -ErrorAction SilentlyContinue
      }
    }
    return
  }
  if ($null -eq $CurrentSha256) {
    return
  }
  if ([string]::IsNullOrEmpty($ReplacementSha256) -or
      $CurrentSha256 -cne $ReplacementSha256) {
    throw "$Label contains unexpected bytes; recovery files were retained."
  }
  $Retired = Join-Path (Split-Path -Parent $Destination) (
    Get-RetiredInstallerFileName `
      $Destination `
      ([Guid]::NewGuid().ToString("N"))
  )
  Move-Item -LiteralPath $Destination -Destination $Retired
  if ([IO.Path]::GetExtension($Destination) -ceq ".exe") {
    Stop-CanonicalRuntimeProcesses $Retired
  }
  Assert-NotReparse $Retired "Retired $Label"
  if (-not (Test-Path -LiteralPath $Retired -PathType Leaf) -or
      (Get-Sha256 $Retired) -cne $ReplacementSha256) {
    throw "The retired $Label changed before rollback cleanup."
  }
  Remove-Item -LiteralPath $Retired -Force
}

function Get-VerifiedLegacyReleaseDigest([string] $Digest) {
  # Authoritative digests of this repository's Windows x64 assets from the
  # releases published before installer receipts were introduced.
  $Published = @{
    # v0.1.0-rc1 and v0.1.0 published the same Windows x64 bytes.
    "da20ac9ec3accb3aed715a064dcd6c250721b1afa2882465d5edef680a813b3d" = "v0.1.0-rc1 or v0.1.0"
    "cb818ee5a6b4037e5d077466bd56ea5cf7c50f5c0816cec7f86d7cd101a0303d" = "v0.1.1"
    "dc36798271253440cb2ab190272c08ce10c4cbebfc59d88a66dd5744c0c2d2d5" = "v0.1.2"
    "88d08b25aac178734f1d030de34e907db04aec41f5834c0a12c0095b51423c6e" = "v0.2.0"
    "52cdb1cc78d4c6315017424a72200e50959d978a8f563f65e25ba32c5d31099a" = "v0.3.0"
    "4e905d9dd43d801ed3662ad4c1a7d774175207d92a1fd761d3b283af291c29de" = "v0.3.2"
  }
  if (-not $Published.ContainsKey($Digest)) {
    return $null
  }
  return $Published[$Digest]
}

function Get-VerifiedLegacyRelease([string] $Executable) {
  $Release = Get-VerifiedLegacyReleaseDigest (Get-Sha256 $Executable)
  if ([string]::IsNullOrEmpty($Release)) {
    throw "Existing $Executable has no receipt and does not match an official pre-receipt sana-mcp release."
  }
  return $Release
}

function Confirm-IncompatibleReplacement([string] $Release) {
  Write-Host ""
  Write-Host "An older incompatible sana-mcp installation was detected ($Release)."
  Write-Host "We can't update it in place, but we can overwrite it with a new installation."
  Write-Host "The meetings will have to be re-synced and you will have to sign in again."
  if ($env:SANA_MCP_REPLACE_INCOMPATIBLE -eq "1") {
    Write-Host "Continuing with the explicitly approved incompatible replacement."
    return $true
  }
  if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
    throw "Incompatible replacement needs an interactive confirmation. Rerun in a terminal, or set SANA_MCP_REPLACE_INCOMPATIBLE=1 to approve this reset explicitly."
  }
  $Answer = Read-Host "Do you want to continue? [y/N]"
  return @("y", "yes") -ccontains $Answer.Trim().ToLowerInvariant()
}

function Get-CanonicalRuntimeProcesses([string] $Executable) {
  $Resolved = [System.IO.Path]::GetFullPath($Executable)
  $ImageName = [IO.Path]::GetFileName($Resolved)
  if ($ImageName -cnotmatch '^[A-Za-z0-9._-]+$') {
    throw "The sana-mcp process image name is invalid."
  }
  $RuntimeProcesses = @()
  foreach ($Process in @(
    Get-CimInstance Win32_Process -Filter "Name = '$ImageName'"
  )) {
    if ([string]::IsNullOrWhiteSpace([string] $Process.ExecutablePath)) {
      continue
    }
    $ProcessPath = [System.IO.Path]::GetFullPath(
      [string] $Process.ExecutablePath
    )
    if (-not [string]::Equals(
      $ProcessPath,
      $Resolved,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      continue
    }
    $RuntimeProcesses += $Process
  }
  return @($RuntimeProcesses)
}

function Get-CanonicalProcessIdentity(
  [object] $Process,
  [string] $Executable
) {
  if ([string]::IsNullOrWhiteSpace([string] $Process.CreationDate)) {
    throw "Windows did not provide a creation time for sana-mcp process $($Process.ProcessId)."
  }
  return [pscustomobject] @{
    processId = [int] $Process.ProcessId
    creationDate = [string] $Process.CreationDate
    executablePath = [System.IO.Path]::GetFullPath($Executable)
  }
}

function Get-RevalidatedCanonicalProcess(
  [object] $Identity
) {
  $Observed = @(
    Get-CimInstance Win32_Process `
      -Filter "ProcessId = $($Identity.processId)"
  )
  if ($Observed.Count -eq 0) {
    return $null
  }
  if ($Observed.Count -ne 1) {
    throw "Windows returned an ambiguous process identity for PID $($Identity.processId)."
  }
  $Process = $Observed[0]
  if ([string]::IsNullOrWhiteSpace([string] $Process.ExecutablePath)) {
    return $null
  }
  $ObservedPath = [System.IO.Path]::GetFullPath(
    [string] $Process.ExecutablePath
  )
  if (-not [string]::Equals(
      $ObservedPath,
      $Identity.executablePath,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    [string] $Process.CreationDate -cne $Identity.creationDate) {
    return $null
  }
  return $Process
}

function Stop-CanonicalRuntimeProcesses([string] $Executable) {
  $Deadline = [DateTime]::UtcNow.AddSeconds(10)
  $EmptyObservations = 0
  while ([DateTime]::UtcNow -lt $Deadline) {
    $Processes = @(Get-CanonicalRuntimeProcesses $Executable)
    if ($Processes.Count -eq 0) {
      $EmptyObservations++
      if ($EmptyObservations -ge 3) {
        return
      }
      Start-Sleep -Milliseconds 100
      continue
    }
    $EmptyObservations = 0
    foreach ($Process in $Processes) {
      $Identity = Get-CanonicalProcessIdentity $Process $Executable
      $Revalidated = Get-RevalidatedCanonicalProcess $Identity
      if ($null -eq $Revalidated) {
        continue
      }
      $Result = Invoke-CimMethod `
        -InputObject $Revalidated `
        -MethodName Terminate
      if ([int] $Result.ReturnValue -ne 0) {
        throw "The previous sana-mcp process $($Identity.processId) could not be stopped (code $($Result.ReturnValue))."
      }
    }
    Start-Sleep -Milliseconds 50
  }
  $Remaining = @(Get-CanonicalRuntimeProcesses $Executable)
  if ($Remaining.Count -gt 0) {
    $Pids = @($Remaining | ForEach-Object { [string] $_.ProcessId })
    throw "Active processes from the installed sana-mcp path did not stop within ten seconds (PIDs $($Pids -join ', '))."
  }
  throw "The installed sana-mcp process retirement barrier did not remain clear."
}

function Get-LegacyDaemonProcesses([string] $Executable) {
  $Resolved = [System.IO.Path]::GetFullPath($Executable)
  $Escaped = [Regex]::Escape($Resolved)
  $QuotedDaemon = '^\s*"' + $Escaped + '"\s+daemon(?:\s|$)'
  $BareDaemon = '^\s*' + $Escaped + '\s+daemon(?:\s|$)'
  $DaemonProcesses = @()
  foreach ($Process in @(Get-CanonicalRuntimeProcesses $Executable)) {
    $CommandLine = [string] $Process.CommandLine
    if ($CommandLine -match $QuotedDaemon -or
        $CommandLine -match $BareDaemon) {
      $DaemonProcesses += $Process
    }
  }
  return @($DaemonProcesses)
}

function Stop-LegacyDaemon([string] $Executable) {
  foreach ($Process in @(Get-LegacyDaemonProcesses $Executable)) {
    $Identity = Get-CanonicalProcessIdentity $Process $Executable
    $Revalidated = Get-RevalidatedCanonicalProcess $Identity
    if ($null -eq $Revalidated) {
      continue
    }
    $Result = Invoke-CimMethod -InputObject $Revalidated -MethodName Terminate
    if ([int] $Result.ReturnValue -ne 0) {
      throw "The previous sana-mcp daemon could not be stopped (code $($Result.ReturnValue))."
    }
  }
  $Deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (@(Get-LegacyDaemonProcesses $Executable).Count -gt 0) {
    if ([DateTime]::UtcNow -ge $Deadline) {
      throw "The previous sana-mcp daemon did not stop within ten seconds."
    }
    Start-Sleep -Milliseconds 50
  }
}

function Start-LegacyDaemon([string] $Executable) {
  Start-Process `
    -FilePath $Executable `
    -ArgumentList @("daemon") `
    -WindowStyle Hidden | Out-Null
  $Deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (@(Get-LegacyDaemonProcesses $Executable).Count -eq 0) {
    if ([DateTime]::UtcNow -ge $Deadline) {
      throw "The restored sana-mcp daemon did not start within ten seconds."
    }
    Start-Sleep -Milliseconds 50
  }
}

function Assert-NotReparse([string] $Path, [string] $Label) {
  if (Test-Path -LiteralPath $Path) {
    $Item = Get-Item -LiteralPath $Path -Force
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label must not be a reparse point."
    }
  }
}

function Resolve-InstallDirectory(
  [object] $ConfiguredDirectory,
  [string] $LocalAppData
) {
  $Directory = if ($null -ne $ConfiguredDirectory) {
    if ($ConfiguredDirectory -isnot [string]) {
      throw "SANA_MCP_INSTALL_DIR must be a string path."
    }
    if ([string]::IsNullOrWhiteSpace($ConfiguredDirectory)) {
      throw "SANA_MCP_INSTALL_DIR must not be empty or whitespace."
    }
    $ConfiguredDirectory
  } else {
    if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
      throw "LOCALAPPDATA is required unless SANA_MCP_INSTALL_DIR is set."
    }
    Join-Path $LocalAppData "sana-mcp"
  }
  if (-not [System.IO.Path]::IsPathRooted($Directory)) {
    throw "SANA_MCP_INSTALL_DIR must be an absolute path."
  }
  $InvalidCharacters = @(
    $Directory.ToCharArray() | Where-Object {
      [int] $_ -lt 32 -or [int] $_ -eq 127
    }
  )
  if ($Directory.Contains(";") -or $InvalidCharacters.Count -gt 0) {
    throw "SANA_MCP_INSTALL_DIR must not contain semicolons or control characters."
  }
  $Canonical = [System.IO.Path]::GetFullPath($Directory)
  $Comparison = $Directory
  $Root = [System.IO.Path]::GetPathRoot($Comparison)
  if ($Comparison.Length -gt $Root.Length) {
    $Comparison = $Comparison.TrimEnd([char[]]"\/")
  }
  if ($Canonical -cne $Comparison) {
    throw "SANA_MCP_INSTALL_DIR must be a canonical absolute path."
  }
  return $Canonical
}

function Normalize-PathEntry([string] $Path) {
  $Expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
  $Full = [IO.Path]::GetFullPath($Expanded)
  $Root = [IO.Path]::GetPathRoot($Full)
  if ($Full.Length -gt $Root.Length) {
    $Full = $Full.TrimEnd([char[]]"\/")
  }
  return $Full.ToUpperInvariant()
}

function ConvertTo-RecoveryPathValue([AllowNull()] [string] $Value) {
  if ($null -eq $Value) {
    return "n"
  }
  $Encoded = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes($Value)
  ).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  return "s.$Encoded"
}

function ConvertFrom-RecoveryPathValue([string] $Value) {
  if ($Value -ceq "n") {
    return $null
  }
  if ($Value -cnotmatch '^s\.([A-Za-z0-9_-]*)$') {
    throw "The incompatible recovery PATH value is invalid."
  }
  $Encoded = $Matches[1].Replace("-", "+").Replace("_", "/")
  switch ($Encoded.Length % 4) {
    0 { }
    2 { $Encoded += "==" }
    3 { $Encoded += "=" }
    default {
      throw "The incompatible recovery PATH value is invalid."
    }
  }
  try {
    $Decoded = [Text.Encoding]::UTF8.GetString(
      [Convert]::FromBase64String($Encoded)
    )
  } catch {
    throw "The incompatible recovery PATH value is invalid."
  }
  if ((ConvertTo-RecoveryPathValue $Decoded) -cne $Value) {
    throw "The incompatible recovery PATH value is not canonical."
  }
  return $Decoded
}

function Read-InstallReceipt([string] $File) {
  $Receipt = Read-Properties $File @(
    "format", "version", "target", "sourceCommit", "binarySha256", "pathManaged",
    "installerProtocol", "lifecycleProtocol", "inspectProtocol", "stateCompatibility"
  )
  foreach ($Key in @("format", "version", "target", "sourceCommit", "binarySha256", "pathManaged")) {
    if (-not $Receipt.ContainsKey($Key)) {
      throw "Installer receipt is missing $Key."
    }
  }
  if (@("sana-mcp-install-v1", "sana-mcp-install-v2") -cnotcontains
      $Receipt["format"]) {
    throw "Existing binary has no supported installer receipt."
  }
  if ($Receipt["format"] -ceq "sana-mcp-install-v1") {
    foreach ($Unexpected in @(
      "installerProtocol", "lifecycleProtocol", "inspectProtocol",
      "stateCompatibility"
    )) {
      if ($Receipt.ContainsKey($Unexpected)) {
        throw "Version 1 installer receipt contains version 2 state."
      }
    }
    $Receipt["installerProtocol"] = "1"
    $Receipt["lifecycleProtocol"] = "1"
    $Receipt["inspectProtocol"] = "1"
    $Receipt["stateCompatibility"] = "1"
  } else {
    foreach ($Required in @(
      "installerProtocol", "lifecycleProtocol", "inspectProtocol",
      "stateCompatibility"
    )) {
      if (-not $Receipt.ContainsKey($Required)) {
        throw "Version 2 installer receipt is missing $Required."
      }
    }
    if ($Receipt["installerProtocol"] -cnotmatch '^[1-9][0-9]*$' -or
        $Receipt["lifecycleProtocol"] -cnotmatch '^[1-9][0-9]*$' -or
        $Receipt["inspectProtocol"] -cnotmatch '^[1-9][0-9]*$' -or
        $Receipt["stateCompatibility"] -cnotmatch '^[1-9][0-9]*$') {
      throw "Version 2 installer receipt protocol state is invalid."
    }
  }
  Assert-ReleaseTag "v$($Receipt["version"])"
  if ($Receipt["sourceCommit"] -cnotmatch '^[a-f0-9]{40}$' -or
      $Receipt["binarySha256"] -cnotmatch '^[a-f0-9]{64}$') {
    throw "Installer receipt integrity fields are invalid."
  }
  if ($Receipt["pathManaged"] -cne "true" -and $Receipt["pathManaged"] -cne "false") {
    throw "Installer receipt PATH state is invalid."
  }
  return $Receipt
}

function Assert-ExpectedUpdateInstallation(
  [hashtable] $Receipt,
  [string] $Digest
) {
  if ($env:SANA_MCP_UPDATE -ne "1") {
    return
  }
  if ([string]::IsNullOrEmpty(
        $env:SANA_MCP_EXPECTED_INSTALLED_VERSION) -or
      [string]::IsNullOrEmpty(
        $env:SANA_MCP_EXPECTED_INSTALLED_TARGET) -or
      [string]::IsNullOrEmpty(
        $env:SANA_MCP_EXPECTED_INSTALLED_SHA256) -or
      [string]::IsNullOrEmpty(
        $env:SANA_MCP_EXPECTED_INSTALLED_STATE_COMPATIBILITY)) {
    throw "sana-mcp update did not provide its complete installed-runtime authority."
  }
  if ($Receipt["version"] -cne
        $env:SANA_MCP_EXPECTED_INSTALLED_VERSION -or
      $Receipt["target"] -cne
        $env:SANA_MCP_EXPECTED_INSTALLED_TARGET -or
      $Digest -cne
        $env:SANA_MCP_EXPECTED_INSTALLED_SHA256 -or
      $Receipt["stateCompatibility"] -cne
        $env:SANA_MCP_EXPECTED_INSTALLED_STATE_COMPATIBILITY) {
    throw "The installed runtime changed after sana-mcp update obtained authority."
  }
}

function Invoke-Lifecycle([string] $Executable, [string] $Operation) {
  $LifecycleFile = Join-Path $TempDir "lifecycle.properties"
  & $Executable __lifecycle $Operation --format properties |
    Set-Content -LiteralPath $LifecycleFile -Encoding ASCII
  $LifecycleExit = $LASTEXITCODE
  if ($LifecycleExit -ne 0) {
    throw "Runtime lifecycle $Operation failed (exit $LifecycleExit)."
  }
  $Lifecycle = Read-Properties $LifecycleFile @(
    "lifecycleProtocol", "state", "changed"
  )
  foreach ($Key in @("lifecycleProtocol", "state", "changed")) {
    if (-not $Lifecycle.ContainsKey($Key)) {
      throw "Runtime lifecycle response is missing $Key."
    }
  }
  if ($Lifecycle["lifecycleProtocol"] -cne "1" -or
      @("running", "stopped") -cnotcontains $Lifecycle["state"] -or
      @("true", "false") -cnotcontains $Lifecycle["changed"]) {
    throw "Runtime lifecycle response is invalid."
  }
  return $Lifecycle
}

function Set-RetainedRuntimeState {
  if (-not $OldPresent -or $null -eq $Destination -or
      -not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
    return
  }
  if ($OldWasRunning) {
    $State = Invoke-Lifecycle $Destination "start"
    if ($State["state"] -cne "running") {
      throw "Replacement runtime could not preserve the previous running state."
    }
  } else {
    $State = Invoke-Lifecycle $Destination "stop"
    if ($State["state"] -cne "stopped") {
      throw "Replacement runtime could not preserve the previous stopped state."
    }
  }
}

function Invoke-InstallerCleanup(
  [AllowNull()] [string] $PendingBinary,
  [AllowNull()] [string] $PendingReceipt,
  [AllowNull()] [IO.FileStream] $OwnedInstallLockHandle,
  [bool] $OwnsInstallLock,
  [AllowNull()] [string] $OwnedInstallLock,
  [AllowNull()] [IO.FileStream] $OwnedPathLockHandle,
  [bool] $OwnsPathLock,
  [AllowNull()] [string] $OwnedPathLock,
  [bool] $KeepTemporary,
  [AllowNull()] [string] $TemporaryDirectory
) {
  $Failures = @()
  try {
    if ($null -ne $OwnedInstallLockHandle) {
      $OwnedInstallLockHandle.Dispose()
    }
  } catch {
    $Failures += "could not release the install-lock handle: $($_.Exception.Message)"
  }
  try {
    if ($null -ne $OwnedPathLockHandle) {
      $OwnedPathLockHandle.Dispose()
    }
  } catch {
    $Failures += "could not release the user-state-lock handle: $($_.Exception.Message)"
  }
  try {
    if (-not [string]::IsNullOrEmpty($PendingBinary) -and
        (Test-Path -LiteralPath $PendingBinary)) {
      Remove-Item -LiteralPath $PendingBinary -Force
    }
  } catch {
    $Failures += "could not remove staged binary: $($_.Exception.Message)"
  }
  try {
    if (-not [string]::IsNullOrEmpty($PendingReceipt) -and
        (Test-Path -LiteralPath $PendingReceipt)) {
      Remove-Item -LiteralPath $PendingReceipt -Force
    }
  } catch {
    $Failures += "could not remove staged receipt: $($_.Exception.Message)"
  }
  try {
    if ($OwnsInstallLock -and
        -not [string]::IsNullOrEmpty($OwnedInstallLock) -and
        (Test-Path -LiteralPath $OwnedInstallLock)) {
      Remove-Item -LiteralPath $OwnedInstallLock -Recurse -Force
    }
  } catch {
    $Failures += "could not release install lock: $($_.Exception.Message)"
  }
  try {
    if ($OwnsPathLock -and
        -not [string]::IsNullOrEmpty($OwnedPathLock) -and
        (Test-Path -LiteralPath $OwnedPathLock)) {
      Remove-Item -LiteralPath $OwnedPathLock -Recurse -Force
    }
  } catch {
    $Failures += "could not release user-state lock: $($_.Exception.Message)"
  }
  try {
    if (-not $KeepTemporary -and
        -not [string]::IsNullOrEmpty($TemporaryDirectory) -and
        (Test-Path -LiteralPath $TemporaryDirectory)) {
      Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
    }
  } catch {
    $Failures += "could not remove temporary installer files: $($_.Exception.Message)"
  }
  return $Failures
}

function New-UserStateLock {
  $Root = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
  )
  if ([string]::IsNullOrWhiteSpace($Root)) {
    throw "Windows did not provide an authoritative per-user directory for installer serialization."
  }
  $Directory = Join-Path $Root ".sana-mcp-installer-path.lock"
  if (Test-Path -LiteralPath $Directory) {
    Assert-NotReparse $Directory "User-state lock"
    $ExistingOwner = Join-Path $Directory "owner.properties"
    if (Test-Path -LiteralPath $ExistingOwner -PathType Leaf) {
      try {
        $Probe = [IO.File]::Open(
          $ExistingOwner,
          [IO.FileMode]::Open,
          [IO.FileAccess]::ReadWrite,
          [IO.FileShare]::None
        )
        $Probe.Dispose()
      } catch [IO.IOException] {
        throw "Another sana-mcp installer is changing user state."
      }
    }
    Remove-Item -LiteralPath $Directory -Recurse -Force
  }
  [IO.Directory]::CreateDirectory($Directory) | Out-Null
  $Owner = Join-Path $Directory "owner.properties"
  [IO.File]::WriteAllText(
    $Owner,
    ("owner=" + [Guid]::NewGuid().ToString("N") + "`n"),
    [Text.Encoding]::ASCII
  )
  try {
    $Handle = [IO.File]::Open(
      $Owner,
      [IO.FileMode]::Open,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
  } catch {
    Remove-Item -LiteralPath $Directory -Recurse -Force `
      -ErrorAction SilentlyContinue
    throw
  }
  return @{
    directory = $Directory
    handle = $Handle
  }
}

function Remove-ResolvedIncompatibleRecovery([string] $RecoveryDirectory) {
  if (-not (Test-Path -LiteralPath $RecoveryDirectory)) {
    return
  }
  $RecoveryParent = Split-Path -Parent $RecoveryDirectory
  $RetiredRecovery = Join-Path $RecoveryParent (
    ".sana-mcp-incompatible-recovery-completed-" +
    [Guid]::NewGuid().ToString("N")
  )
  Move-Item -LiteralPath $RecoveryDirectory -Destination $RetiredRecovery
  try {
    Remove-Item -LiteralPath $RetiredRecovery -Recurse -Force
  } catch {
    [Console]::Error.WriteLine(
      "sana-mcp: completed recovery cleanup was retained at $RetiredRecovery"
    )
  }
}

function Get-ValidatedRecoveryReplacementReceiptHash(
  [string] $Receipt,
  [hashtable] $Inventory,
  [bool] $WasLegacy,
  [bool] $HasReplacementReceiptAuthority
) {
  if (-not (Test-Path -LiteralPath $Receipt -PathType Leaf)) {
    return $null
  }
  $ReceiptHash = Get-Sha256 $Receipt
  if (-not $WasLegacy -and
      $ReceiptHash -ceq $Inventory["previousReceiptSha256"]) {
    return $null
  }
  if (-not $HasReplacementReceiptAuthority) {
    throw "The incompatible recovery journal lacks authority for the published replacement receipt."
  }
  $ReplacementReceipt = Read-InstallReceipt $Receipt
  if ($ReplacementReceipt["format"] -cne "sana-mcp-install-v2" -or
      $ReplacementReceipt["binarySha256"] -cne
        $Inventory["replacementBinarySha256"] -or
      $ReplacementReceipt["version"] -cne
        $Inventory["replacementVersion"] -or
      $ReplacementReceipt["target"] -cne
        $Inventory["replacementTarget"] -or
      $ReplacementReceipt["sourceCommit"] -cne
        $Inventory["replacementSourceCommit"] -or
      $ReplacementReceipt["installerProtocol"] -cne
        $Inventory["replacementInstallerProtocol"] -or
      $ReplacementReceipt["lifecycleProtocol"] -cne
        $Inventory["replacementLifecycleProtocol"] -or
      $ReplacementReceipt["inspectProtocol"] -cne
        $Inventory["replacementInspectProtocol"] -or
      $ReplacementReceipt["stateCompatibility"] -cne
        $Inventory["replacementStateCompatibility"] -or
      $ReplacementReceipt["pathManaged"] -cne
        $Inventory["replacementPathManaged"]) {
    throw "The incompatible recovery replacement receipt is not authoritative."
  }
  if ($Inventory.ContainsKey("replacementReceiptSha256") -and
      $ReceiptHash -cne $Inventory["replacementReceiptSha256"]) {
    throw "The incompatible recovery replacement receipt digest changed."
  }
  return $ReceiptHash
}

function Remove-OrphanRetiredInstallerFiles(
  [string] $Executable,
  [string] $Receipt,
  [hashtable] $Inventory,
  [AllowNull()] [string] $AuthorizedReplacementReceiptSha256
) {
  $InstallDirectory = [IO.Path]::GetFullPath(
    (Split-Path -Parent $Executable)
  )
  if (-not [string]::Equals(
      $InstallDirectory,
      [IO.Path]::GetFullPath((Split-Path -Parent $Receipt)),
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Recovery runtime and receipt directories do not match."
  }
  Assert-NotReparse $InstallDirectory "Install directory"
  $TokenMarker = "0123456789abcdef0123456789abcdef"
  $BinaryPattern = "^" + [Regex]::Escape(
    (Get-RetiredInstallerFileName $Executable $TokenMarker)
  ).Replace($TokenMarker, "[a-f0-9]{32}") + "$"
  $ReceiptPattern = "^" + [Regex]::Escape(
    (Get-RetiredInstallerFileName $Receipt $TokenMarker)
  ).Replace($TokenMarker, "[a-f0-9]{32}") + "$"
  $Candidates = @(
    Get-ChildItem -LiteralPath $InstallDirectory -Force |
      Where-Object {
        [Regex]::IsMatch(
          $_.Name,
          $BinaryPattern,
          [Text.RegularExpressions.RegexOptions]::CultureInvariant
        ) -or
        [Regex]::IsMatch(
          $_.Name,
          $ReceiptPattern,
          [Text.RegularExpressions.RegexOptions]::CultureInvariant
        )
      }
  )
  if ($Candidates.Count -gt 64) {
    throw "Too many retired installer artifacts require recovery."
  }
  foreach ($Candidate in $Candidates) {
    Assert-NotReparse $Candidate.FullName "Retired installer artifact"
    if ($Candidate.PSIsContainer -or
        -not (Test-Path -LiteralPath $Candidate.FullName -PathType Leaf)) {
      throw "A retired installer artifact is not a regular file: $($Candidate.FullName)"
    }
    $Digest = Get-Sha256 $Candidate.FullName
    $IsBinary = [Regex]::IsMatch(
      $Candidate.Name,
      $BinaryPattern,
      [Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
    if ($IsBinary) {
      if (@(
          $Inventory["previousBinarySha256"],
          $Inventory["replacementBinarySha256"]
        ) -cnotcontains $Digest) {
        throw "A retired runtime has an unexpected digest: $($Candidate.FullName)"
      }
      Stop-CanonicalRuntimeProcesses $Candidate.FullName
    } else {
      $AllowedReceiptDigests = @()
      if ($Inventory["previousReceiptSha256"] -cmatch
          '^[a-f0-9]{64}$') {
        $AllowedReceiptDigests +=
          $Inventory["previousReceiptSha256"]
      }
      if (-not [string]::IsNullOrEmpty(
          $AuthorizedReplacementReceiptSha256)) {
        $AllowedReceiptDigests +=
          $AuthorizedReplacementReceiptSha256
      }
      if ($AllowedReceiptDigests -cnotcontains $Digest) {
        throw "A retired receipt has an unexpected or unprovable digest: $($Candidate.FullName)"
      }
    }
    Assert-NotReparse $Candidate.FullName "Retired installer artifact"
    if (-not (Test-Path -LiteralPath $Candidate.FullName -PathType Leaf) -or
        (Get-Sha256 $Candidate.FullName) -cne $Digest) {
      throw "A retired installer artifact changed before deletion: $($Candidate.FullName)"
    }
    Remove-Item -LiteralPath $Candidate.FullName -Force
    if (Test-Path -LiteralPath $Candidate.FullName) {
      throw "A retired installer artifact could not be removed: $($Candidate.FullName)"
    }
  }
}

function Invoke-PendingIncompatibleRecovery(
  [string] $Executable,
  [string] $Receipt,
  [string] $RecoveryDirectory,
  [string] $InstallLockDirectory
) {
  Assert-NotReparse $RecoveryDirectory "Incompatible recovery directory"
  if (Test-Path -LiteralPath $Executable) {
    Assert-NotReparse $Executable "Installed binary"
  }
  if (Test-Path -LiteralPath $Receipt) {
    Assert-NotReparse $Receipt "Installer receipt"
  }
  if (Test-Path -LiteralPath $InstallLockDirectory) {
    Assert-NotReparse $InstallLockDirectory "Install lock"
    $OwnerFile = Join-Path $InstallLockDirectory "owner.properties"
    if (-not (Test-Path -LiteralPath $OwnerFile -PathType Leaf)) {
      throw "The incomplete incompatible replacement has an unowned install lock: $InstallLockDirectory"
    }
    try {
      $LockProbe = [IO.File]::Open(
        $OwnerFile,
        [IO.FileMode]::Open,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
      )
      $LockProbe.Dispose()
    } catch [IO.IOException] {
      throw "Another sana-mcp install is still recovering the incompatible installation."
    }
    Remove-Item -LiteralPath $InstallLockDirectory -Recurse -Force
  }

  $InventoryFile = Join-Path $RecoveryDirectory "installer.properties"
  if (-not (Test-Path -LiteralPath $InventoryFile -PathType Leaf)) {
    throw "The incompatible replacement recovery inventory is missing."
  }
  $Inventory = Read-Properties $InventoryFile @(
    "format", "oldWasRunning", "legacyInstall",
    "previousBinarySha256", "previousReceiptSha256",
    "replacementBinarySha256", "replacementVersion",
    "replacementTarget", "replacementStateCompatibility",
    "replacementSourceCommit", "replacementInstallerProtocol",
    "replacementLifecycleProtocol", "replacementInspectProtocol",
    "replacementReceiptSha256", "replacementPathManaged",
    "previousUserPath", "publishedUserPath"
  )
  if ($Inventory["format"] -cne "sana-mcp-incompatible-recovery-v1" -or
      @("true", "false") -cnotcontains $Inventory["oldWasRunning"] -or
      @("true", "false") -cnotcontains $Inventory["legacyInstall"] -or
      $Inventory["previousBinarySha256"] -cnotmatch '^[a-f0-9]{64}$' -or
      $Inventory["replacementBinarySha256"] -cnotmatch '^[a-f0-9]{64}$' -or
      $Inventory["replacementVersion"] -cnotmatch '^[0-9A-Za-z.+-]+$' -or
      $Inventory["replacementTarget"] -cne "bun-windows-x64" -or
      $Inventory["replacementStateCompatibility"] -cnotmatch '^[1-9][0-9]*$') {
    throw "The incompatible replacement recovery inventory is invalid."
  }
  $ReplacementAuthorityKeys = @(
    "replacementSourceCommit", "replacementInstallerProtocol",
    "replacementLifecycleProtocol", "replacementInspectProtocol"
  )
  $ReplacementAuthorityCount = @(
    $ReplacementAuthorityKeys | Where-Object {
      $Inventory.ContainsKey($_)
    }
  ).Count
  if ($ReplacementAuthorityCount -ne 0 -and
      $ReplacementAuthorityCount -ne $ReplacementAuthorityKeys.Count) {
    throw "The incompatible replacement recovery receipt authority is incomplete."
  }
  $HasReplacementReceiptAuthority =
    $ReplacementAuthorityCount -eq $ReplacementAuthorityKeys.Count
  if ($HasReplacementReceiptAuthority -and
      ($Inventory["replacementSourceCommit"] -cnotmatch '^[a-f0-9]{40}$' -or
       $Inventory["replacementInstallerProtocol"] -cnotmatch '^[1-9][0-9]*$' -or
       $Inventory["replacementLifecycleProtocol"] -cnotmatch '^[1-9][0-9]*$' -or
       $Inventory["replacementInspectProtocol"] -cnotmatch '^[1-9][0-9]*$')) {
    throw "The incompatible replacement recovery receipt authority is invalid."
  }
  if ($Inventory.ContainsKey("replacementReceiptSha256") -and
      $Inventory["replacementReceiptSha256"] -cnotmatch '^[a-f0-9]{64}$') {
    throw "The incompatible replacement recovery receipt digest is invalid."
  }
  $PathAuthorityKeys = @(
    "replacementPathManaged", "previousUserPath", "publishedUserPath"
  )
  $PathAuthorityCount = @(
    $PathAuthorityKeys | Where-Object {
      $Inventory.ContainsKey($_)
    }
  ).Count
  if ($PathAuthorityCount -ne $PathAuthorityKeys.Count) {
    throw "The incompatible replacement recovery PATH authority is unavailable."
  }
  if (@("true", "false") -cnotcontains
      $Inventory["replacementPathManaged"]) {
    throw "The incompatible replacement recovery PATH ownership is invalid."
  }
  $RecoveryPreviousUserPath =
    ConvertFrom-RecoveryPathValue $Inventory["previousUserPath"]
  $RecoveryPublishedUserPath =
    ConvertFrom-RecoveryPathValue $Inventory["publishedUserPath"]
  if ($Inventory["replacementPathManaged"] -ceq "false" -and
      $RecoveryPublishedUserPath -cne $RecoveryPreviousUserPath) {
    throw "The incompatible replacement recovery PATH journal claims an unowned mutation."
  }
  $PreviousExecutable =
    Join-Path $RecoveryDirectory "previous-sana-mcp.exe"
  $ReplacementExecutable =
    Join-Path $RecoveryDirectory "replacement-sana-mcp.exe"
  $PreviousReceipt =
    Join-Path $RecoveryDirectory "previous-receipt"
  foreach ($RequiredBinary in @(
      $PreviousExecutable, $ReplacementExecutable
    )) {
    Assert-NotReparse $RequiredBinary "Incompatible recovery binary"
    if (-not (Test-Path -LiteralPath $RequiredBinary -PathType Leaf)) {
      throw "The incompatible replacement recovery binary inventory is incomplete."
    }
  }
  if ((Get-Sha256 $PreviousExecutable) -cne
      $Inventory["previousBinarySha256"] -or
      (Get-Sha256 $ReplacementExecutable) -cne
      $Inventory["replacementBinarySha256"]) {
    throw "The incompatible replacement recovery binaries changed."
  }
  $WasLegacy = $Inventory["legacyInstall"] -ceq "true"
  if (-not $WasLegacy) {
    Assert-NotReparse $PreviousReceipt "Previous installer receipt"
    if (-not (Test-Path -LiteralPath $PreviousReceipt -PathType Leaf)) {
      throw "The incompatible replacement recovery receipt is missing."
    }
    if ($Inventory["previousReceiptSha256"] -cnotmatch '^[a-f0-9]{64}$' -or
        (Get-Sha256 $PreviousReceipt) -cne
        $Inventory["previousReceiptSha256"]) {
      throw "The previous incompatible replacement receipt changed."
    }
  } elseif ($Inventory["previousReceiptSha256"] -cne "none") {
    throw "The legacy incompatible recovery inventory is invalid."
  }
  $JournalFile =
    Join-Path $RecoveryDirectory "incompatible-reset.json"
  $RecoveryReplacementReceiptHash = $null
  if (-not (Test-Path -LiteralPath $JournalFile -PathType Leaf)) {
    $NeedsReset = $true
    $NeedsCommit = $false
    $RecoveryReplacementReceiptHash =
      Get-ValidatedRecoveryReplacementReceiptHash `
        $Receipt `
        $Inventory `
        $WasLegacy `
        $HasReplacementReceiptAuthority
  } else {
    $StatusFile = [IO.Path]::GetTempFileName()
    $RecoveryInspectFile = [IO.Path]::GetTempFileName()
    $PreviousResetAuthority = $env:SANA_MCP_INCOMPATIBLE_RESET
    try {
      & $ReplacementExecutable __inspect --format properties |
        Set-Content -LiteralPath $RecoveryInspectFile -Encoding ASCII
      if ($LASTEXITCODE -ne 0) {
        throw "The incompatible recovery runtime could not be inspected."
      }
      $RecoveryInspect = Read-Properties $RecoveryInspectFile @(
        "inspectProtocol", "version", "target", "installerProtocol",
        "lifecycleProtocol", "stateCompatibility", "semanticCapability"
      )
      if ($RecoveryInspect["inspectProtocol"] -cne "1" -or
          $RecoveryInspect["installerProtocol"] -cne "1" -or
          $RecoveryInspect["lifecycleProtocol"] -cne "1" -or
          $RecoveryInspect["version"] -cne
            $Inventory["replacementVersion"] -or
          $RecoveryInspect["target"] -cne
            $Inventory["replacementTarget"] -or
          $RecoveryInspect["stateCompatibility"] -cne
            $Inventory["replacementStateCompatibility"]) {
        throw "The incompatible recovery runtime identity is invalid."
      }
      $env:SANA_MCP_INCOMPATIBLE_RESET = "1"
      & $ReplacementExecutable __reset-incompatible-state status `
        --journal $RecoveryDirectory `
        --format properties |
        Set-Content -LiteralPath $StatusFile -Encoding ASCII
      if ($LASTEXITCODE -ne 0) {
        throw "The incompatible recovery status could not be read."
      }
      $Status = Read-Properties $StatusFile @(
        "resetProtocol", "transactionState"
      )
      if ($Status["resetProtocol"] -cne "1") {
        throw "The incompatible recovery protocol is unsupported."
      }
      $NeedsReset = @(
        "prepared", "quarantined", "fresh",
        "rollback-started", "rolled-back"
      ) -ccontains $Status["transactionState"]
      $NeedsCommit = @(
        "commit-started", "committed"
      ) -ccontains $Status["transactionState"]
      if (-not $NeedsReset -and -not $NeedsCommit) {
        throw "The incompatible recovery transaction state is invalid."
      }
      $RecoveryReplacementReceiptHash =
        Get-ValidatedRecoveryReplacementReceiptHash `
          $Receipt `
          $Inventory `
          $WasLegacy `
          $HasReplacementReceiptAuthority
      if ($NeedsCommit) {
        if ([Environment]::GetEnvironmentVariable("Path", "User") -cne
            $RecoveryPublishedUserPath) {
          throw "The committed incompatible replacement User PATH changed."
        }
        if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or
            -not $Inventory.ContainsKey("replacementReceiptSha256") -or
            $RecoveryReplacementReceiptHash -cne
              $Inventory["replacementReceiptSha256"]) {
          throw "The committed incompatible replacement runtime is incomplete."
        }
        if ((Get-Sha256 $Executable) -cne
              $Inventory["replacementBinarySha256"]) {
          throw "The committed incompatible replacement runtime changed."
        }
      }
      if ($NeedsReset) {
        $StoppedForRecovery =
          Invoke-Lifecycle $ReplacementExecutable "stop"
        if ($StoppedForRecovery["state"] -cne "stopped") {
          throw "The replacement daemon did not stop before incompatible recovery."
        }
      }
      $RecoveryOperation = if ($NeedsCommit) { "commit" } else { "rollback" }
      & $ReplacementExecutable __reset-incompatible-state $RecoveryOperation `
        --journal $RecoveryDirectory `
        --format properties | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "The incomplete incompatible replacement could not be recovered."
      }
    } finally {
      if ($null -eq $PreviousResetAuthority) {
        Remove-Item Env:SANA_MCP_INCOMPATIBLE_RESET -ErrorAction SilentlyContinue
      } else {
        $env:SANA_MCP_INCOMPATIBLE_RESET = $PreviousResetAuthority
      }
      Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $RecoveryInspectFile -Force `
        -ErrorAction SilentlyContinue
    }
  }

  if ($NeedsReset) {
    $RecoveryCurrentUserPath =
      [Environment]::GetEnvironmentVariable("Path", "User")
    if ($Inventory["replacementPathManaged"] -ceq "true") {
      if ($RecoveryCurrentUserPath -ceq
          $RecoveryPreviousUserPath) {
        # The PATH side of rollback was already completed.
      } elseif ($RecoveryCurrentUserPath -ceq
          $RecoveryPublishedUserPath) {
        [Environment]::SetEnvironmentVariable(
          "Path",
          $RecoveryPreviousUserPath,
          "User"
        )
        if ([Environment]::GetEnvironmentVariable("Path", "User") -cne
            $RecoveryPreviousUserPath) {
          throw "The previous User PATH could not be restored during incompatible recovery."
        }
      } else {
        throw "The User PATH changed concurrently during incompatible recovery."
      }
    } elseif ($RecoveryCurrentUserPath -cne
        $RecoveryPreviousUserPath) {
      throw "The unowned User PATH changed during incompatible recovery."
    }
    $CurrentBinaryHash = if (
      Test-Path -LiteralPath $Executable -PathType Leaf
    ) {
      Get-Sha256 $Executable
    } else {
      $null
    }
    if ($null -ne $CurrentBinaryHash -and
        $CurrentBinaryHash -cne $Inventory["previousBinarySha256"] -and
        $CurrentBinaryHash -cne $Inventory["replacementBinarySha256"]) {
      throw "The installed binary contains unexpected bytes; recovery files were retained."
    }
    if ($CurrentBinaryHash -ceq
        $Inventory["replacementBinarySha256"]) {
      Stop-CanonicalRuntimeProcesses $Executable
    }
    $RecoveryBinaryError = $null
    $RecoveryReceiptError = $null
    try {
      Restore-InstallerFileState `
        $Executable `
        $PreviousExecutable `
        $Inventory["previousBinarySha256"] `
        $Inventory["replacementBinarySha256"] `
        "installed binary"
    } catch {
      $RecoveryBinaryError = $_.Exception.Message
    }
    $ReplacementReceiptHash =
      $RecoveryReplacementReceiptHash
    $RecoveryPreviousReceipt = if ($WasLegacy) {
      $null
    } else {
      $PreviousReceipt
    }
    $RecoveryPreviousReceiptHash = if ($WasLegacy) {
      $null
    } else {
      $Inventory["previousReceiptSha256"]
    }
    try {
      Restore-InstallerFileState `
        $Receipt `
        $RecoveryPreviousReceipt `
        $RecoveryPreviousReceiptHash `
        $ReplacementReceiptHash `
        "installer receipt"
    } catch {
      $RecoveryReceiptError = $_.Exception.Message
    }
    if ($null -ne $RecoveryBinaryError -or
        $null -ne $RecoveryReceiptError) {
      throw "Could not reconcile the interrupted incompatible replacement: binary=$RecoveryBinaryError; receipt=$RecoveryReceiptError"
    }
    if ($Inventory["oldWasRunning"] -ceq "true") {
      if ($WasLegacy) {
        Start-LegacyDaemon $Executable
      } else {
        $Restarted = Invoke-Lifecycle $Executable "start"
        if ($Restarted["state"] -cne "running") {
          throw "The previous runtime did not restart during incompatible recovery."
        }
      }
    }
  }
  $AuthorizedReplacementReceiptSha256 = if (
    $HasReplacementReceiptAuthority -and
    $Inventory.ContainsKey("replacementReceiptSha256")
  ) {
    $Inventory["replacementReceiptSha256"]
  } else {
    $null
  }
  Remove-OrphanRetiredInstallerFiles `
    $Executable `
    $Receipt `
    $Inventory `
    $AuthorizedReplacementReceiptSha256
  Remove-ResolvedIncompatibleRecovery $RecoveryDirectory
  return @{
    restoredPrevious = $NeedsReset
  }
}

try {
  $NativeArchitecture = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
  } else {
    $env:PROCESSOR_ARCHITECTURE
  }
  switch ($NativeArchitecture) {
    "AMD64" { $Target = "bun-windows-x64" }
    "ARM64" { throw "Windows ARM64 is not in the currently verified release matrix." }
    default { throw "Unsupported Windows architecture: $NativeArchitecture" }
  }

  $PreflightInstallDir = Resolve-InstallDirectory `
    $env:SANA_MCP_INSTALL_DIR `
    $env:LOCALAPPDATA
  $PreflightDestination = Join-Path $PreflightInstallDir "sana-mcp.exe"
  $PreflightReceipt = Join-Path $PreflightInstallDir ".sana-mcp-install-v1"
  $PreflightInstallLock =
    Join-Path $PreflightInstallDir ".sana-mcp-install-lock"
  $PreflightRecovery =
    Join-Path $PreflightInstallDir ".sana-mcp-incompatible-recovery"
  if (Test-Path -LiteralPath $PreflightRecovery) {
    $RecoveryLock = New-UserStateLock
    $PathLock = $RecoveryLock["directory"]
    $PathLockHandle = $RecoveryLock["handle"]
    $PathLockAcquired = $true
    $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) (
      "sana-mcp-recovery-" + [Guid]::NewGuid().ToString("N")
    )
    [System.IO.Directory]::CreateDirectory($TempDir) | Out-Null
    $RecoveredIncompatible = Invoke-PendingIncompatibleRecovery `
      $PreflightDestination `
      $PreflightReceipt `
      $PreflightRecovery `
      $PreflightInstallLock
    if ($RecoveredIncompatible.restoredPrevious) {
      Write-Host "Restored the previous installation after an interrupted incompatible replacement."
    } else {
      Write-Host "Completed cleanup from the previous incompatible replacement."
    }
    Remove-Item -LiteralPath $TempDir -Recurse -Force
    $TempDir = $null
  }
  $PreflightDestinationExists =
    Test-Path -LiteralPath $PreflightDestination -PathType Leaf
  $PreflightReceiptExists =
    Test-Path -LiteralPath $PreflightReceipt -PathType Leaf
  if ($env:SANA_MCP_UPDATE -eq "1" -and
      (-not $PreflightDestinationExists -or
       -not $PreflightReceiptExists)) {
    throw "The installed runtime changed after sana-mcp update obtained authority."
  }
  if ($PreflightDestinationExists -and -not $PreflightReceiptExists) {
    $IncompatibleDigest = Get-Sha256 $PreflightDestination
    $LegacyRelease =
      Get-VerifiedLegacyReleaseDigest $IncompatibleDigest
    if ([string]::IsNullOrEmpty($LegacyRelease)) {
      throw "Existing $PreflightDestination has no receipt and does not match an official pre-receipt sana-mcp release."
    }
    if ((Test-Path Env:SANA_DATA_DIR) -or
        (Test-Path Env:SANA_TRANSCRIPTS_DIR)) {
      throw "Automatic incompatible replacement is unavailable with SANA_DATA_DIR or SANA_TRANSCRIPTS_DIR. Move those Sana directories manually, then rerun the installer."
    }
    if (-not (Confirm-IncompatibleReplacement $LegacyRelease)) {
      Write-Host "Installation cancelled. Nothing was changed."
      return
    }
    $IncompatibleInstall = $true
    $IncompatibleStateReset = $true
  } elseif ($PreflightDestinationExists -ne $PreflightReceiptExists) {
    throw "The install destination is not a complete installer-owned sana-mcp installation."
  }

  $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("sana-mcp-" + [Guid]::NewGuid().ToString("N"))
  [System.IO.Directory]::CreateDirectory($TempDir) | Out-Null
  $MetadataName = "manifest-$Target.properties"

  if ($env:SANA_MCP_VERSION) {
    Assert-ReleaseTag $env:SANA_MCP_VERSION
    $Version = $env:SANA_MCP_VERSION
  } else {
    $Bootstrap = Join-Path $TempDir "bootstrap.properties"
    $BootstrapChecksum = Join-Path $TempDir "bootstrap.properties.sha256"
    Download-Https "https://github.com/$Repo/releases/latest/download/$MetadataName" $Bootstrap
    Download-Https "https://github.com/$Repo/releases/latest/download/$MetadataName.sha256" $BootstrapChecksum
    $BootstrapExpected = Read-Checksum $BootstrapChecksum $MetadataName
    if ((Get-Sha256 $Bootstrap) -cne $BootstrapExpected) {
      throw "Latest release metadata checksum mismatch."
    }
    $BootstrapValues = Read-ReleaseProperties $Bootstrap $Target
    $Version = $BootstrapValues["releaseTag"]
  }

  $BaseUrl = "https://github.com/$Repo/releases/download/$Version"
  Write-Host "Installing sana-mcp $Version ($Target)"

  $PropertiesFile = Join-Path $TempDir "release.properties"
  $PropertiesChecksum = Join-Path $TempDir "release.properties.sha256"
  Download-Https "$BaseUrl/$MetadataName" $PropertiesFile
  Download-Https "$BaseUrl/$MetadataName.sha256" $PropertiesChecksum
  $Expected = Read-Checksum $PropertiesChecksum $MetadataName
  if ((Get-Sha256 $PropertiesFile) -cne $Expected) {
    throw "Release metadata checksum mismatch."
  }
  $Release = Read-ReleaseProperties $PropertiesFile $Target
  if ($Release["releaseTag"] -cne $Version) {
    throw "Release metadata resolved to a different tag."
  }
  if ($PreflightDestinationExists -and $PreflightReceiptExists) {
    Assert-NotReparse $PreflightDestination "Installed binary"
    Assert-NotReparse $PreflightReceipt "Installer receipt"
    $PreflightOwnedReceipt = Read-InstallReceipt $PreflightReceipt
    $PreflightOwnedDigest = Get-Sha256 $PreflightDestination
    if ($PreflightOwnedReceipt["target"] -cne $Target -or
        $PreflightOwnedDigest -cne
          $PreflightOwnedReceipt["binarySha256"]) {
      throw "The existing installation does not match its installer receipt."
    }
    Assert-ExpectedUpdateInstallation `
      $PreflightOwnedReceipt `
      $PreflightOwnedDigest
    if ($PreflightOwnedReceipt["stateCompatibility"] -cne
        $Release["stateCompatibility"]) {
      if ((Test-Path Env:SANA_DATA_DIR) -or
          (Test-Path Env:SANA_TRANSCRIPTS_DIR)) {
        throw "Automatic incompatible replacement is unavailable with SANA_DATA_DIR or SANA_TRANSCRIPTS_DIR. Move those Sana directories manually, then rerun the installer."
      }
      if (-not (Confirm-IncompatibleReplacement "state compatibility $($PreflightOwnedReceipt["stateCompatibility"])")) {
        Write-Host "Installation cancelled. Nothing was changed."
        return
      }
      $IncompatibleReceiptConfirmed = $true
      $IncompatibleStateReset = $true
      $IncompatibleDigest = $PreflightOwnedDigest
    }
  }

  if (-not $PathLockAcquired) {
    $UserStateLock = New-UserStateLock
    $PathLock = $UserStateLock["directory"]
    $PathLockHandle = $UserStateLock["handle"]
    $PathLockAcquired = $true
  }

  $Manifest = Join-Path $TempDir "manifest.json"
  $ManifestChecksum = Join-Path $TempDir "manifest.json.sha256"
  Download-Https "$BaseUrl/manifest.json" $Manifest
  Download-Https "$BaseUrl/manifest.json.sha256" $ManifestChecksum
  $Expected = Read-Checksum $ManifestChecksum "manifest.json"
  $ManifestHash = Get-Sha256 $Manifest
  if ($ManifestHash -cne $Expected) { throw "Release manifest checksum mismatch." }
  if ($ManifestHash -cne $Release["manifestSha256"]) {
    throw "Release metadata is not bound to the downloaded manifest."
  }

  $Binary = Join-Path $TempDir "sana-mcp.exe"
  $BinaryChecksum = Join-Path $TempDir "binary.sha256"
  Download-Https "$BaseUrl/$($Release["checksumFileName"])" $BinaryChecksum
  $Expected = Read-Checksum $BinaryChecksum $Release["assetName"]
  if ($Expected -cne $Release["sha256"]) {
    throw "Binary checksum does not match the release manifest."
  }
  Download-Https "$BaseUrl/$($Release["assetName"])" $Binary -ShowProgress
  if ((Get-Sha256 $Binary) -cne $Release["sha256"]) {
    throw "Downloaded binary checksum mismatch."
  }

  $InspectFile = Join-Path $TempDir "inspect.properties"
  & $Binary __inspect --format properties | Set-Content -LiteralPath $InspectFile -Encoding ASCII
  $InspectExit = $LASTEXITCODE
  if ($InspectExit -ne 0) {
    throw "Downloaded binary could not report its release identity (exit $InspectExit)."
  }
  $Inspect = Read-Properties $InspectFile @(
    "inspectProtocol", "version", "target", "installerProtocol",
    "lifecycleProtocol", "stateCompatibility", "semanticCapability"
  )
  foreach ($Key in @(
    "inspectProtocol", "version", "target", "installerProtocol",
    "lifecycleProtocol", "stateCompatibility", "semanticCapability"
  )) {
    if (-not $Inspect.ContainsKey($Key)) {
      throw "Downloaded binary inspection is missing $Key."
    }
  }
  if ($Inspect["inspectProtocol"] -cne $Release["inspectProtocol"] -or
      $Inspect["version"] -cne $Release["packageVersion"] -or
      $Inspect["target"] -cne $Release["target"] -or
      $Inspect["installerProtocol"] -cne $Release["installerProtocol"] -or
      $Inspect["lifecycleProtocol"] -cne $Release["lifecycleProtocol"] -or
      $Inspect["stateCompatibility"] -cne $Release["stateCompatibility"] -or
      $Inspect["semanticCapability"] -cne $Release["semanticCapability"]) {
    throw "Downloaded binary identity does not match the release manifest."
  }

  $InstallDir = Resolve-InstallDirectory `
    $env:SANA_MCP_INSTALL_DIR `
    $env:LOCALAPPDATA
  Assert-NotReparse $InstallDir "Install directory"
  [System.IO.Directory]::CreateDirectory($InstallDir) | Out-Null
  Assert-NotReparse $InstallDir "Install directory"

  $Destination = Join-Path $InstallDir "sana-mcp.exe"
  $ReceiptPath = Join-Path $InstallDir ".sana-mcp-install-v1"
  $InstallLock = Join-Path $InstallDir ".sana-mcp-install-lock"
  Assert-NotReparse $Destination "Installed binary"
  Assert-NotReparse $ReceiptPath "Installer receipt"
  if (Test-Path -LiteralPath $InstallLock) {
    throw "Another sana-mcp install is active, or a stale install lock needs to be removed: $InstallLock"
  }
  New-Item -ItemType Directory -Path $InstallLock | Out-Null
  $LockAcquired = $true
  $InstallLockOwner = Join-Path $InstallLock "owner.properties"
  $InstallLockOwnerBody =
    "owner=" + [Guid]::NewGuid().ToString("N")
  [IO.File]::WriteAllText(
    $InstallLockOwner,
    "$InstallLockOwnerBody`n",
    [Text.Encoding]::ASCII
  )
  $InstallLockHandle = [IO.File]::Open(
    $InstallLockOwner,
    [IO.FileMode]::Open,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )

  $DestinationExists = Test-Path -LiteralPath $Destination -PathType Leaf
  $ReceiptExists = Test-Path -LiteralPath $ReceiptPath -PathType Leaf
  if ($DestinationExists -and -not $ReceiptExists) {
    if (-not $IncompatibleInstall -or
        (Get-Sha256 $Destination) -cne $IncompatibleDigest) {
      throw "The incompatible installation changed after confirmation; nothing was replaced."
    }
    $LegacyRelease = Get-VerifiedLegacyRelease $Destination
    $OldPresent = $true
    $LegacyInstall = $true
    $IncompatibleStateReset = $true
    $OldWasRunning =
      @(Get-LegacyDaemonProcesses $Destination).Count -gt 0
    $OldBinaryBackup = Join-Path $TempDir "previous-sana-mcp.exe"
    Copy-Item -LiteralPath $Destination -Destination $OldBinaryBackup
    $OldBinaryDigest = $IncompatibleDigest
    Write-Host "Verified official pre-receipt sana-mcp $LegacyRelease."
  }
  if (-not $LegacyInstall -and $DestinationExists -ne $ReceiptExists) {
    throw "The install destination is not a complete installer-owned sana-mcp installation."
  }

  if ($DestinationExists -and -not $LegacyInstall) {
    $OldPresent = $true
    $OldReceipt = Read-InstallReceipt $ReceiptPath
    if ($OldReceipt["target"] -cne $Target) {
      throw "The existing installer receipt belongs to a different target."
    }
    $OldDigest = Get-Sha256 $Destination
    if ($OldDigest -cne $OldReceipt["binarySha256"]) {
      throw "The existing binary no longer matches its installer receipt."
    }
    Assert-ExpectedUpdateInstallation $OldReceipt $OldDigest
    if ($OldReceipt["stateCompatibility"] -cne
        $Release["stateCompatibility"]) {
      if (-not $IncompatibleReceiptConfirmed -or
          $OldDigest -cne $IncompatibleDigest) {
        throw "The incompatible installation changed after confirmation; nothing was replaced."
      }
      $IncompatibleStateReset = $true
    }

    $OldInspectFile = Join-Path $TempDir "old-inspect.properties"
    & $Destination __inspect --format properties |
      Set-Content -LiteralPath $OldInspectFile -Encoding ASCII
    $OldInspectExit = $LASTEXITCODE
    if ($OldInspectExit -ne 0) {
      throw "The existing binary could not prove its installer identity (exit $OldInspectExit)."
    }
    $OldInspect = Read-Properties $OldInspectFile @(
      "inspectProtocol", "version", "target", "installerProtocol",
      "lifecycleProtocol", "stateCompatibility", "semanticCapability"
    )
    foreach ($Key in @(
      "inspectProtocol", "version", "target", "installerProtocol",
      "lifecycleProtocol", "semanticCapability"
    )) {
      if (-not $OldInspect.ContainsKey($Key)) {
        throw "The existing binary inspection is missing $Key."
      }
    }
    if ($OldReceipt["format"] -ceq "sana-mcp-install-v1") {
      if ($OldInspect.ContainsKey("stateCompatibility")) {
        throw "The existing v1 binary inspection unexpectedly declares state compatibility."
      }
      $OldInspect["stateCompatibility"] = "1"
    } elseif (-not $OldInspect.ContainsKey("stateCompatibility")) {
      throw "The existing binary inspection is missing stateCompatibility."
    }
    if ($OldInspect["inspectProtocol"] -cne "1" -or
        $OldInspect["installerProtocol"] -cne "1" -or
        $OldInspect["lifecycleProtocol"] -cne "1" -or
        $OldInspect["stateCompatibility"] -cne
          $OldReceipt["stateCompatibility"] -or
        $OldInspect["target"] -cne $OldReceipt["target"] -or
        $OldInspect["version"] -cne $OldReceipt["version"]) {
      throw "The existing binary identity does not match its installer receipt."
    }

    $NewPathManaged = $OldReceipt["pathManaged"] -ceq "true"
    $OldLifecycle = Invoke-Lifecycle $Destination "health"
    $OldWasRunning = $OldLifecycle["state"] -ceq "running"
    $OldBinaryBackup = Join-Path $TempDir "previous-sana-mcp.exe"
    $OldReceiptBackup = Join-Path $TempDir "previous-receipt"
    Copy-Item -LiteralPath $Destination -Destination $OldBinaryBackup
    Copy-Item -LiteralPath $ReceiptPath -Destination $OldReceiptBackup
    $OldBinaryDigest = $OldDigest
    $OldReceiptDigest = Get-Sha256 $OldReceiptBackup
  }

  $ShouldRunAfterInstall = Get-ShouldRunAfterInstall `
    ($OldPresent -and -not $LegacyInstall) `
    $OldWasRunning `
    ($env:SANA_MCP_UPDATE -eq "1") `
    $IncompatibleStateReset

  $OldUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $UserEntries = if ([string]::IsNullOrEmpty($OldUserPath)) {
    @()
  } else {
    @($OldUserPath -split ";" | Where-Object {
      -not [string]::IsNullOrWhiteSpace($_)
    })
  }
  $NormalizedInstallDir = Normalize-PathEntry $InstallDir
  $MatchingEntries = @(
    $UserEntries | Where-Object {
      (Normalize-PathEntry $_) -eq $NormalizedInstallDir
    }
  )
  if ($MatchingEntries.Count -gt 1) {
    throw "The user PATH contains duplicate entries for $InstallDir; remove the duplicates before installing."
  }
  if ($OldPresent -and -not $LegacyInstall) {
    if ($NewPathManaged -and $MatchingEntries.Count -gt 1) {
      throw "Multiple installer-owned PATH entries; remove duplicates manually."
    }
  } else {
    $NewPathManaged = $MatchingEntries.Count -eq 0
  }
  $NewUserPath = if (
    $NewPathManaged -and $MatchingEntries.Count -eq 0
  ) {
    if ([string]::IsNullOrEmpty($OldUserPath)) {
      $InstallDir
    } else {
      "$OldUserPath;$InstallDir"
    }
  } else {
    $null
  }
  $ExpectedCurrentUserPath = if ($null -ne $NewUserPath) {
    $NewUserPath
  } else {
    $OldUserPath
  }

  if ($IncompatibleStateReset) {
    $IncompatibleResetJournal =
      Join-Path $InstallDir ".sana-mcp-incompatible-recovery"
    if (Test-Path -LiteralPath $IncompatibleResetJournal) {
      throw "An incompatible replacement recovery directory already exists: $IncompatibleResetJournal"
    }
    $RecoveryStage = Join-Path $InstallDir (
      ".sana-mcp-incompatible-recovery-stage-" +
      [Guid]::NewGuid().ToString("N")
    )
    try {
      [IO.Directory]::CreateDirectory($RecoveryStage) | Out-Null
      Copy-Item -LiteralPath $OldBinaryBackup -Destination (
        Join-Path $RecoveryStage "previous-sana-mcp.exe"
      )
      Copy-Item -LiteralPath $Binary -Destination (
        Join-Path $RecoveryStage "replacement-sana-mcp.exe"
      )
      if (-not $LegacyInstall) {
        Copy-Item -LiteralPath $OldReceiptBackup -Destination (
          Join-Path $RecoveryStage "previous-receipt"
        )
      }
      $PreviousReceiptHash = if ($LegacyInstall) {
        "none"
      } else {
        Get-Sha256 $OldReceiptBackup
      }
      $RecoveryInventory = @(
        "format=sana-mcp-incompatible-recovery-v1"
        "oldWasRunning=$($OldWasRunning.ToString().ToLowerInvariant())"
        "legacyInstall=$($LegacyInstall.ToString().ToLowerInvariant())"
        "previousBinarySha256=$(Get-Sha256 $OldBinaryBackup)"
        "previousReceiptSha256=$PreviousReceiptHash"
        "replacementBinarySha256=$($Release["sha256"])"
        "replacementVersion=$($Release["packageVersion"])"
        "replacementTarget=$($Release["target"])"
        "replacementStateCompatibility=$($Release["stateCompatibility"])"
        "replacementSourceCommit=$($Release["sourceCommit"])"
        "replacementInstallerProtocol=$($Release["installerProtocol"])"
        "replacementLifecycleProtocol=$($Release["lifecycleProtocol"])"
        "replacementInspectProtocol=$($Release["inspectProtocol"])"
        "replacementPathManaged=$($NewPathManaged.ToString().ToLowerInvariant())"
        "previousUserPath=$(ConvertTo-RecoveryPathValue $OldUserPath)"
        "publishedUserPath=$(ConvertTo-RecoveryPathValue $ExpectedCurrentUserPath)"
      ) -join "`n"
      [IO.File]::WriteAllText(
        (Join-Path $RecoveryStage "installer.properties"),
        "$RecoveryInventory`n",
        [Text.Encoding]::ASCII
      )
      Move-Item -LiteralPath $RecoveryStage `
        -Destination $IncompatibleResetJournal
    } catch {
      if (Test-Path -LiteralPath $RecoveryStage) {
        Remove-Item -LiteralPath $RecoveryStage -Recurse -Force `
          -ErrorAction SilentlyContinue
      }
      throw
    }
  }

  $StagedBinary = Join-Path $InstallDir (".sana-mcp-" + [Guid]::NewGuid().ToString("N") + ".exe")
  Copy-Item -LiteralPath $Binary -Destination $StagedBinary

  $TransactionActive = $true
  if ($OldWasRunning) {
    if ($LegacyInstall) {
      Stop-LegacyDaemon $Destination
    } else {
      $Stopped = Invoke-Lifecycle $Destination "stop"
      if ($Stopped["state"] -cne "stopped") {
        throw "The previous sana-mcp daemon did not stop."
      }
    }
  }
  if ($OldPresent) {
    Stop-CanonicalRuntimeProcesses $Destination
  }

  Publish-InstallerFile `
    $StagedBinary `
    $Destination `
    $Release["sha256"] `
    $OldBinaryDigest `
    ([ref] $RetiredBinary)
  $StagedBinary = $null

  if ($NewPathManaged -and $MatchingEntries.Count -eq 0) {
    $PathBeforePublication = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($PathBeforePublication -cne $OldUserPath) {
      throw "The user PATH changed while the installer was preparing its update."
    }
    [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
    $WrittenUserPath = $NewUserPath
    $PathChanged = $true
    if (
      [Environment]::GetEnvironmentVariable("Path", "User") -cne
        $WrittenUserPath
    ) {
      throw "The published user PATH update could not be verified."
    }
  }

  if (
    [Environment]::GetEnvironmentVariable("Path", "User") -cne
      $ExpectedCurrentUserPath
  ) {
    throw "The user PATH changed before the installer receipt was published."
  }

  $StagedReceipt = Join-Path $InstallDir (".sana-mcp-receipt-" + [Guid]::NewGuid().ToString("N"))
  $ReceiptBody = @(
    "format=sana-mcp-install-v2"
    "version=$($Release["packageVersion"])"
    "target=$($Release["target"])"
    "sourceCommit=$($Release["sourceCommit"])"
    "binarySha256=$($Release["sha256"])"
    "pathManaged=$($NewPathManaged.ToString().ToLowerInvariant())"
    "installerProtocol=$($Release["installerProtocol"])"
    "lifecycleProtocol=$($Release["lifecycleProtocol"])"
    "inspectProtocol=$($Release["inspectProtocol"])"
    "stateCompatibility=$($Release["stateCompatibility"])"
  ) -join "`n"
  [IO.File]::WriteAllText($StagedReceipt, "$ReceiptBody`n", [Text.Encoding]::ASCII)
  $NewReceiptDigest = Get-Sha256 $StagedReceipt
  Publish-InstallerFile `
    $StagedReceipt `
    $ReceiptPath `
    $NewReceiptDigest `
    $OldReceiptDigest `
    ([ref] $RetiredReceipt)
  $StagedReceipt = $null

  if ($IncompatibleStateReset) {
    $RecoveryInventoryFile =
      Join-Path $IncompatibleResetJournal "installer.properties"
    $RecoveryInventoryText =
      [IO.File]::ReadAllText($RecoveryInventoryFile)
    if ($RecoveryInventoryText -match
        '(?m)^replacementReceiptSha256=') {
      throw "The incompatible recovery receipt digest was already recorded."
    }
    $RecoveryInventoryUpdate =
      Join-Path $IncompatibleResetJournal (
        ".installer-properties-update-" +
        [Guid]::NewGuid().ToString("N")
      )
    $RecoveryInventoryBackup =
      Join-Path $IncompatibleResetJournal "installer.properties.previous"
    $UpdatedRecoveryInventoryText =
      $RecoveryInventoryText.TrimEnd("`r", "`n") +
      "`nreplacementReceiptSha256=$NewReceiptDigest`n"
    [IO.File]::WriteAllText(
      $RecoveryInventoryUpdate,
      $UpdatedRecoveryInventoryText,
      [Text.Encoding]::ASCII
    )
    $UpdatedRecoveryInventoryHash =
      Get-Sha256 $RecoveryInventoryUpdate
    [IO.File]::Replace(
      $RecoveryInventoryUpdate,
      $RecoveryInventoryFile,
      $RecoveryInventoryBackup,
      $true
    )
    if ((Get-Sha256 $RecoveryInventoryFile) -cne
        $UpdatedRecoveryInventoryHash) {
      throw "The incompatible recovery receipt authority was not published exactly."
    }
    if (Test-Path -LiteralPath $RecoveryInventoryBackup) {
      Remove-Item -LiteralPath $RecoveryInventoryBackup -Force
    }
  }

  if ($IncompatibleStateReset) {
    $PreviousResetAuthority = $env:SANA_MCP_INCOMPATIBLE_RESET
    try {
      $env:SANA_MCP_INCOMPATIBLE_RESET = "1"
      $ResetOutput = @(
        & $Destination __reset-incompatible-state prepare `
          --journal $IncompatibleResetJournal `
          --install-dir $InstallDir `
          --format properties
      )
      $ResetExit = $LASTEXITCODE
    } finally {
      if ($null -eq $PreviousResetAuthority) {
        Remove-Item Env:SANA_MCP_INCOMPATIBLE_RESET -ErrorAction SilentlyContinue
      } else {
        $env:SANA_MCP_INCOMPATIBLE_RESET = $PreviousResetAuthority
      }
    }
    $IncompatibleResetPrepared = Test-Path -LiteralPath (
      Join-Path $IncompatibleResetJournal "incompatible-reset.json"
    ) -PathType Leaf
    if ($ResetExit -ne 0) {
      throw "The incompatible local Sana state could not be reset (exit $ResetExit)."
    }
    $ResetFile = Join-Path $TempDir "incompatible-reset.properties"
    [IO.File]::WriteAllText(
      $ResetFile,
      (($ResetOutput -join "`n") + "`n"),
      [Text.Encoding]::ASCII
    )
    $Reset = Read-Properties $ResetFile @(
      "resetProtocol", "state", "quarantinePresent"
    )
    if ($Reset["resetProtocol"] -cne "1" -or
        $Reset["state"] -cne "fresh" -or
        @("true", "false") -cnotcontains $Reset["quarantinePresent"]) {
      throw "The incompatible local Sana reset returned an invalid response."
    }
    $IncompatibleResetPrepared = $true
    Write-Host "Removed the incompatible local session and meeting cache."
  }

  if (-not $IncompatibleStateReset) {
    $RuntimeStateTouched = $true
  }
  if ($ShouldRunAfterInstall) {
    $Started = Invoke-Lifecycle $Destination "start"
    if ($Started["state"] -cne "running") {
      throw "The upgraded sana-mcp daemon did not start."
    }
  } else {
    $Health = Invoke-Lifecycle $Destination "health"
    if ($OldPresent -and $Health["state"] -ceq "running") {
      $Stopped = Invoke-Lifecycle $Destination "stop"
      if ($Stopped["state"] -cne "stopped") {
        throw "The upgrade did not preserve the previous stopped-daemon state."
      }
    }
  }

  if (
    [Environment]::GetEnvironmentVariable("Path", "User") -cne
      $ExpectedCurrentUserPath
  ) {
    throw "The user PATH changed before installation completed."
  }

  if ($null -ne $RetiredBinary) {
    if (-not (Test-Path -LiteralPath $RetiredBinary -PathType Leaf) -or
        (Get-Sha256 $RetiredBinary) -cne $OldBinaryDigest -or
        -not (Test-Path -LiteralPath $Destination -PathType Leaf) -or
        (Get-Sha256 $Destination) -cne $Release["sha256"]) {
      throw "Published runtime retirement state changed before commit."
    }
    Stop-CanonicalRuntimeProcesses $Destination
    Stop-CanonicalRuntimeProcesses $RetiredBinary
    if ((Get-Sha256 $RetiredBinary) -cne $OldBinaryDigest -or
        (Get-Sha256 $Destination) -cne $Release["sha256"]) {
      throw "Published runtime retirement state changed during commit."
    }
  }
  if ($null -ne $RetiredReceipt -and
      (-not (Test-Path -LiteralPath $RetiredReceipt -PathType Leaf) -or
       (Get-Sha256 $RetiredReceipt) -cne $OldReceiptDigest -or
       -not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf) -or
       (Get-Sha256 $ReceiptPath) -cne $NewReceiptDigest)) {
    throw "Published receipt retirement state changed before commit."
  }
  if ($OldPresent -and $ShouldRunAfterInstall) {
    $RestartedAfterRetirement = Invoke-Lifecycle $Destination "start"
    if ($RestartedAfterRetirement["state"] -cne "running") {
      throw "The upgraded sana-mcp daemon did not restart after runtime retirement."
    }
  }

  if ($IncompatibleResetPrepared) {
    $PreviousResetAuthority = $env:SANA_MCP_INCOMPATIBLE_RESET
    try {
      $env:SANA_MCP_INCOMPATIBLE_RESET = "1"
      & $Destination __reset-incompatible-state commit `
        --journal $IncompatibleResetJournal `
        --format properties |
        Set-Content -LiteralPath (
          Join-Path $TempDir "incompatible-reset-commit.properties"
        ) -Encoding ASCII
      $ResetCommitExit = $LASTEXITCODE
      if ($ResetCommitExit -ne 0) {
        throw "reset cleanup returned exit $ResetCommitExit"
      }
      $ResetCommit = Read-Properties (
        Join-Path $TempDir "incompatible-reset-commit.properties"
      ) @("resetProtocol", "state", "quarantinePresent")
      if ($ResetCommit["resetProtocol"] -cne "1" -or
          $ResetCommit["state"] -cne "committed" -or
          $ResetCommit["quarantinePresent"] -cne "false") {
        throw "reset cleanup returned an invalid committed response"
      }
    } finally {
      if ($null -eq $PreviousResetAuthority) {
        Remove-Item Env:SANA_MCP_INCOMPATIBLE_RESET -ErrorAction SilentlyContinue
      } else {
        $env:SANA_MCP_INCOMPATIBLE_RESET = $PreviousResetAuthority
      }
    }
    $IncompatibleResetPrepared = $false
  }

  $Committed = $true
  $TransactionActive = $false
  if ($null -ne $RetiredBinary) {
    try {
      Stop-CanonicalRuntimeProcesses $RetiredBinary
      Assert-NotReparse $RetiredBinary "Retired runtime"
      if (-not (Test-Path -LiteralPath $RetiredBinary -PathType Leaf) -or
          (Get-Sha256 $RetiredBinary) -cne $OldBinaryDigest) {
        throw "retired runtime changed before post-commit deletion"
      }
      $RetiredBinarySafeToDelete = $true
      Remove-Item -LiteralPath $RetiredBinary -Force
      $RetiredBinary = $null
    } catch {
      [Console]::Error.WriteLine(
        "sana-mcp: installation succeeded; deferred retired runtime cleanup remains at $RetiredBinary"
      )
    }
  }
  if ($null -ne $RetiredReceipt) {
    try {
      Assert-NotReparse $RetiredReceipt "Retired receipt"
      if (-not (Test-Path -LiteralPath $RetiredReceipt -PathType Leaf) -or
          (Get-Sha256 $RetiredReceipt) -cne $OldReceiptDigest) {
        throw "retired receipt changed before post-commit deletion"
      }
      $RetiredReceiptSafeToDelete = $true
      Remove-Item -LiteralPath $RetiredReceipt -Force
      $RetiredReceipt = $null
    } catch {
      [Console]::Error.WriteLine(
        "sana-mcp: installation succeeded; deferred retired receipt cleanup remains at $RetiredReceipt"
      )
    }
  }
  if ($IncompatibleStateReset) {
    $RetiredBinaryRemains =
      -not [string]::IsNullOrEmpty($RetiredBinary) -and
      (Test-Path -LiteralPath $RetiredBinary -PathType Leaf)
    $RetiredReceiptRemains =
      -not [string]::IsNullOrEmpty($RetiredReceipt) -and
      (Test-Path -LiteralPath $RetiredReceipt -PathType Leaf)
    if (-not $RetiredBinaryRemains -and
        -not $RetiredReceiptRemains) {
      try {
        Remove-ResolvedIncompatibleRecovery $IncompatibleResetJournal
      } catch {
        [Console]::Error.WriteLine(
          "sana-mcp: installation succeeded, but committed recovery cleanup remains pending: $($_.Exception.Message)"
        )
        [Console]::Error.WriteLine(
          "sana-mcp: deferred recovery path: $IncompatibleResetJournal"
        )
      }
    } else {
      if ($RetiredBinaryRemains) {
        [Console]::Error.WriteLine(
          "sana-mcp: deferred retired runtime cleanup remains at $RetiredBinary"
        )
      }
      if ($RetiredReceiptRemains) {
        [Console]::Error.WriteLine(
          "sana-mcp: deferred retired receipt cleanup remains at $RetiredReceipt"
        )
      }
      [Console]::Error.WriteLine(
        "sana-mcp: deferred recovery path: $IncompatibleResetJournal"
      )
    }
  }
} catch {
  $InstallError = $_.Exception.Message
  $RollbackErrors = @()
  $StateRollbackCompleted = $false
  $PreviousRuntimeRestarted = -not ($OldPresent -and $OldWasRunning)
  if ($TransactionActive -and -not $Committed) {
    $ResetJournalPublished =
      -not [string]::IsNullOrEmpty($IncompatibleResetJournal) -and
      (Test-Path -LiteralPath (
        Join-Path $IncompatibleResetJournal "incompatible-reset.json"
      ) -PathType Leaf)
    if ($IncompatibleStateReset -and -not $ResetJournalPublished) {
      $StateRollbackCompleted = $true
    }
    if ($IncompatibleResetPrepared -or $ResetJournalPublished) {
      $PreviousResetAuthority = $env:SANA_MCP_INCOMPATIBLE_RESET
      try {
        $StoppedBeforeStateRollback =
          Invoke-Lifecycle $Destination "stop"
        if ($StoppedBeforeStateRollback["state"] -cne "stopped") {
          throw "replacement daemon did not stop before local-state rollback"
        }
        $env:SANA_MCP_INCOMPATIBLE_RESET = "1"
        & $Destination __reset-incompatible-state rollback `
          --journal $IncompatibleResetJournal `
          --format properties | Out-Null
        if ($LASTEXITCODE -ne 0) {
          throw "reset rollback returned exit $LASTEXITCODE"
        }
        $IncompatibleResetPrepared = $false
        $StateRollbackCompleted = $true
      } catch {
        $RetainNewRuntime = $true
        $PreserveTemp = $true
        $StateRecoveryIncomplete = $true
        $RollbackErrors +=
          "incompatible local-state rollback was incomplete: $($_.Exception.Message)"
      } finally {
        if ($null -eq $PreviousResetAuthority) {
          Remove-Item Env:SANA_MCP_INCOMPATIBLE_RESET -ErrorAction SilentlyContinue
        } else {
          $env:SANA_MCP_INCOMPATIBLE_RESET = $PreviousResetAuthority
        }
      }
    }
    $CanRestoreFiles = -not $RetainNewRuntime -and -not $RuntimeStateTouched
    $FilesRestored = $false
    if ($RuntimeStateTouched) {
      $RetainNewRuntime = $true
      $PreserveTemp = $true
      try {
        Set-RetainedRuntimeState
      } catch {
        $RollbackErrors += $_.Exception.Message
      }
    } elseif ($RetainNewRuntime) {
      try {
        if ($StateRecoveryIncomplete) {
          $StoppedAfterRecoveryFailure =
            Invoke-Lifecycle $Destination "stop"
          if ($StoppedAfterRecoveryFailure["state"] -cne "stopped") {
            throw "Replacement runtime could not be stopped after local-state recovery failed."
          }
        } else {
          Set-RetainedRuntimeState
        }
      } catch {
        $RollbackErrors += $_.Exception.Message
      }
    }
    if ($CanRestoreFiles) {
      $BinaryRestored = $false
      $ReceiptRestored = $false
      try {
        if (Test-Path -LiteralPath $Destination -PathType Leaf) {
          $RollbackBinaryDigest = Get-Sha256 $Destination
          if ($RollbackBinaryDigest -ceq $Release["sha256"] -and
              $RollbackBinaryDigest -cne $OldBinaryDigest) {
            Stop-CanonicalRuntimeProcesses $Destination
          }
        }
        Restore-InstallerFileState `
          $Destination `
          $OldBinaryBackup `
          $OldBinaryDigest `
          $Release["sha256"] `
          "installed binary"
        $BinaryRestored = $true
        $RetiredBinarySafeToDelete = $true
      } catch {
        $RollbackErrors += "could not restore installed binary: $($_.Exception.Message)"
      }
      try {
        Restore-InstallerFileState `
          $ReceiptPath `
          $OldReceiptBackup `
          $OldReceiptDigest `
          $NewReceiptDigest `
          "installer receipt"
        $ReceiptRestored = $true
        $RetiredReceiptSafeToDelete = $true
      } catch {
        $RollbackErrors += "could not restore installer receipt: $($_.Exception.Message)"
      }
      $FilesRestored = $BinaryRestored -and $ReceiptRestored
    }
    if ($CanRestoreFiles -and $PathChanged) {
      try {
        $CurrentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if ($CurrentUserPath -cne $WrittenUserPath) {
          throw "the user PATH changed concurrently after installer publication"
        }
        [Environment]::SetEnvironmentVariable("Path", $OldUserPath, "User")
      } catch {
        $RollbackErrors += "could not restore the user PATH: $($_.Exception.Message)"
      }
    }
    if ($FilesRestored -and $OldPresent -and $OldWasRunning) {
      try {
        if ($null -eq $Destination -or
            -not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
          throw "restored runtime is unavailable"
        }
        if ($LegacyInstall) {
          Start-LegacyDaemon $Destination
        } else {
          $Restarted = Invoke-Lifecycle $Destination "start"
          if ($Restarted["state"] -cne "running") {
            throw "previous runtime did not restart"
          }
        }
        $PreviousRuntimeRestarted = $true
      } catch {
        $RollbackErrors += "could not restart the previous runtime: $($_.Exception.Message)"
      }
    }
    if ($StateRollbackCompleted -and $FilesRestored -and
        $PreviousRuntimeRestarted -and
        -not [string]::IsNullOrEmpty($IncompatibleResetJournal)) {
      try {
        Remove-ResolvedIncompatibleRecovery $IncompatibleResetJournal
      } catch {
        $PreserveTemp = $true
        $RollbackErrors +=
          "could not remove the completed incompatible recovery inventory: $($_.Exception.Message)"
      }
    }
    if ($RetainNewRuntime) {
      [Console]::Error.WriteLine(
        "sana-mcp: retained the replacement runtime at $Destination"
      )
      if ($null -ne $TempDir) {
        [Console]::Error.WriteLine(
          "sana-mcp: previous runtime backup and recovery inventory: $TempDir"
        )
      }
    }
  }
  if ($RollbackErrors.Count -gt 0) {
    $PreserveTemp = $true
    [Console]::Error.WriteLine(
      "sana-mcp rollback was incomplete: " + ($RollbackErrors -join "; ")
    )
    if ($null -ne $TempDir) {
      [Console]::Error.WriteLine("Recovery files were retained at $TempDir")
    }
  }
  $InstallFailure = "sana-mcp: $InstallError"
} finally {
  foreach ($RetiredArtifact in @(
      @{
        path = $RetiredBinary
        safe = $RetiredBinarySafeToDelete
        kind = "runtime"
        expectedSha256 = $OldBinaryDigest
        executable = $true
      },
      @{
        path = $RetiredReceipt
        safe = $RetiredReceiptSafeToDelete
        kind = "receipt"
        expectedSha256 = $OldReceiptDigest
        executable = $false
      }
    )) {
    try {
      if (-not [string]::IsNullOrEmpty($RetiredArtifact.path) -and
          (Test-Path -LiteralPath $RetiredArtifact.path)) {
        if ($RetiredArtifact.safe) {
          if ($RetiredArtifact.executable) {
            Stop-CanonicalRuntimeProcesses $RetiredArtifact.path
          }
          Assert-NotReparse `
            $RetiredArtifact.path `
            "Retired $($RetiredArtifact.kind)"
          if (-not (Test-Path `
                -LiteralPath $RetiredArtifact.path `
                -PathType Leaf) -or
              (Get-Sha256 $RetiredArtifact.path) -cne
                $RetiredArtifact.expectedSha256) {
            throw "retired $($RetiredArtifact.kind) changed before final deletion"
          }
          Remove-Item -LiteralPath $RetiredArtifact.path -Force
        } else {
          $PreserveTemp = $true
          [Console]::Error.WriteLine(
            "sana-mcp: retained authoritative retired file at $($RetiredArtifact.path)"
          )
        }
      }
    } catch {
      if ($Committed) {
        [Console]::Error.WriteLine(
          "sana-mcp: deferred retired-file cleanup remains at $($RetiredArtifact.path): $($_.Exception.Message)"
        )
      } else {
        $CleanupErrors +=
          "could not remove safe retired installer artifact $($RetiredArtifact.path): $($_.Exception.Message)"
      }
    }
  }
  $CleanupErrors += @(
    Invoke-InstallerCleanup `
      $StagedBinary `
      $StagedReceipt `
      $InstallLockHandle `
      $LockAcquired `
      $InstallLock `
      $PathLockHandle `
      $PathLockAcquired `
      $PathLock `
      $PreserveTemp `
      $TempDir
  )
}
if ($CleanupErrors.Count -gt 0) {
  $CleanupContext = "cleanup was incomplete: " + ($CleanupErrors -join "; ")
  if ($null -ne $InstallFailure) {
    $InstallFailure = "$InstallFailure; $CleanupContext"
  } else {
    $InstallFailure = "sana-mcp: $CleanupContext"
  }
}
if ($null -ne $InstallFailure) {
  throw [InvalidOperationException]::new($InstallFailure)
}
if ($env:SANA_MCP_UPDATE -eq "1") {
  if ($IncompatibleStateReset) {
    Write-Host "Setup was deferred because this incompatible replacement was started by sana-mcp update."
    Write-Host "Run this command to configure clients and sign in: $(Format-InstallCommand $Destination)"
  }
} elseif ($env:SANA_MCP_YES -eq "1") {
  $SetupOutcome =
    Invoke-PostInstallConfigurer $Destination -Yes
  if ($SetupOutcome.state -ceq "exited") {
    [Console]::Error.WriteLine(
      "sana-mcp: installation succeeded, but client registration exited with code $($SetupOutcome.exitCode)."
    )
    [Console]::Error.WriteLine(
      "sana-mcp: retry with: $(Format-InstallCommand $Destination -Yes)"
    )
  } elseif ($SetupOutcome.state -ceq "launch-failed") {
    [Console]::Error.WriteLine(
      "sana-mcp: installation succeeded, but client registration could not start: $($SetupOutcome.message)"
    )
    [Console]::Error.WriteLine(
      "sana-mcp: retry with: $(Format-InstallCommand $Destination -Yes)"
    )
  }
} else {
  $SetupOutcome =
    Invoke-PostInstallConfigurer $Destination
  if ($SetupOutcome.state -ceq "exited") {
    [Console]::Error.WriteLine(
      "sana-mcp: installation succeeded, but setup exited with code $($SetupOutcome.exitCode)."
    )
    [Console]::Error.WriteLine(
      "sana-mcp: retry with: $(Format-InstallCommand $Destination)"
    )
  } elseif ($SetupOutcome.state -ceq "launch-failed") {
    [Console]::Error.WriteLine(
      "sana-mcp: installation succeeded, but setup could not start: $($SetupOutcome.message)"
    )
    [Console]::Error.WriteLine(
      "sana-mcp: retry with: $(Format-InstallCommand $Destination)"
    )
  }
}
if ($env:SANA_MCP_UPDATE -ne "1") {
  [void] (Publish-CurrentProcessPath $InstallDir $Destination)
}
} finally {
  if ($CallerHadLastExitCode) {
    Set-Variable -Name LASTEXITCODE -Value $CallerLastExitCode -Scope 1
  } else {
    Remove-Variable -Name LASTEXITCODE -Scope 1 -ErrorAction SilentlyContinue
  }
  if (-not $CallerAndGlobalLastExitCodeAreSame) {
    if ($GlobalHadLastExitCode) {
      Set-Variable -Name LASTEXITCODE -Value $GlobalLastExitCode -Scope Global
    } else {
      Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    }
  }
}
}
