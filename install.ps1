# Install the latest sana-mcp release:
#   irm https://github.com/Lumen-AiApp/sana-ai-mcp/releases/latest/download/install.ps1 | iex
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
$Repo = "Lumen-AiApp/sana-ai-mcp"
$TempDir = $null
$StagedBinary = $null
$InstallLock = $null
$PathLock = $null
$Destination = $null
$ReceiptPath = $null
$TransactionActive = $false
$Committed = $false
$OldPresent = $false
$LegacyInstall = $false
$OldWasRunning = $false
$PathChanged = $false
$OldUserPath = $null
$PreserveTemp = $false
$LockAcquired = $false
$PathLockAcquired = $false
$OldBinaryBackup = $null
$OldReceiptBackup = $null
$NewPathManaged = $false
$StagedReceipt = $null
$WrittenUserPath = $null
$ConfigJournalDir = $null
$ConfigJournalFile = $null
$ConfigTransactionState = "none"
$RetainNewRuntime = $false
$ConfigJournalPreexisting = $false
$LiveStateTouched = $false
$InstallFailure = $null
$CleanupErrors = @()
$AuthMigrationState = "not-run"

function Assert-ReleaseTag([string] $Tag) {
  if ($Tag -cnotmatch '\Av(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?\z') {
    throw "Release metadata contains an invalid tag."
  }
}

function Format-InstallCommand([string] $Executable) {
  if ([string]::IsNullOrWhiteSpace($Executable)) {
    throw "The installed executable path is unavailable."
  }
  return "& '" + $Executable.Replace("'", "''") + "' install"
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
  if ($TotalBytes -le 0) {
    return (
      "`r  {0} MB  {1} MB/s " -f
        $ReadMegabytes,
        $SpeedMegabytes
    )
  }

  $Ratio = [Math]::Min(
    1.0,
    [Math]::Max(0.0, $BytesRead / [double] $TotalBytes)
  )
  $Percent = [int] [Math]::Floor($Ratio * 100)
  $TotalMegabytes = [Math]::Round($TotalBytes / 1MB, 1)
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
      $ReadMegabytes,
      $TotalMegabytes,
      $SpeedMegabytes,
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
    "semanticCapability", "target", "libc", "assetName",
    "checksumFileName", "sha256"
  )
  $Values = Read-Properties $File $Allowed
  $Required = @(
    "format", "manifestVersion", "manifestSha256", "packageVersion",
    "releaseTag", "sourceCommit", "installerProtocol", "lifecycleProtocol", "inspectProtocol",
    "semanticCapability", "target", "assetName", "checksumFileName", "sha256"
  )
  foreach ($Key in $Required) {
    if (-not $Values.ContainsKey($Key)) { throw "Release metadata is missing $Key." }
  }
  if ($Values["format"] -cne "sana-mcp-release-v1") { throw "Unsupported release metadata format." }
  if ($Values["manifestVersion"] -cne "1") { throw "Unsupported release manifest version." }
  if ($Values["installerProtocol"] -cne "1") { throw "Unsupported installer protocol." }
  if ($Values["lifecycleProtocol"] -cne "1") { throw "Unsupported lifecycle protocol." }
  if ($Values["inspectProtocol"] -cne "1") { throw "Unsupported inspect protocol." }
  if ($Values["semanticCapability"] -cne "keyword") { throw "Unsupported binary capability." }
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

function Get-LegacyDaemonProcesses([string] $Executable) {
  $Resolved = [System.IO.Path]::GetFullPath($Executable)
  $Escaped = [Regex]::Escape($Resolved)
  $QuotedDaemon = '^\s*"' + $Escaped + '"\s+daemon(?:\s|$)'
  $BareDaemon = '^\s*' + $Escaped + '\s+daemon(?:\s|$)'
  $DaemonProcesses = @()
  foreach ($Process in @(
    Get-CimInstance Win32_Process -Filter "Name = 'sana-mcp.exe'"
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
    $CommandLine = [string] $Process.CommandLine
    if ($CommandLine -notmatch $QuotedDaemon -and
        $CommandLine -notmatch $BareDaemon) {
      throw "The official legacy sana-mcp executable is active outside daemon mode; close it and rerun the installer."
    }
    $DaemonProcesses += $Process
  }
  return @($DaemonProcesses)
}

function Stop-LegacyDaemon([string] $Executable) {
  foreach ($Process in @(Get-LegacyDaemonProcesses $Executable)) {
    $Result = Invoke-CimMethod -InputObject $Process -MethodName Terminate
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

function Read-InstallReceipt([string] $File) {
  $Receipt = Read-Properties $File @(
    "format", "version", "target", "sourceCommit", "binarySha256", "pathManaged"
  )
  foreach ($Key in @(
    "format", "version", "target", "sourceCommit", "binarySha256", "pathManaged"
  )) {
    if (-not $Receipt.ContainsKey($Key)) {
      throw "Installer receipt is missing $Key."
    }
  }
  if ($Receipt["format"] -cne "sana-mcp-install-v1") {
    throw "Existing binary has no supported installer receipt."
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

function Read-ConfigTransactionResult(
  [object[]] $Output,
  [string] $ExpectedOperation,
  [int] $ExitCode,
  [string] $ExpectedJournal
) {
  if ($Output.Count -ne 1 -or $null -eq $Output[0]) {
    throw "Client configuration returned an invalid number of response lines."
  }
  $Raw = [string] $Output[0]
  if ([string]::IsNullOrWhiteSpace($Raw)) {
    throw "Client configuration returned an empty response."
  }
  try {
    $Value = $Raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Client configuration returned malformed JSON."
  }
  $Allowed = @(
    "transactionProtocol", "operation", "outcome", "appliedCount", "noopCount",
    "journal", "errorCode", "message", "disposition", "authentication"
  )
  $Properties = @($Value.PSObject.Properties)
  $Names = @($Properties | ForEach-Object { $_.Name })
  foreach ($Property in $Properties) {
    if ($Allowed -cnotcontains $Property.Name) {
      throw "Client configuration returned an unknown response field."
    }
  }
  foreach ($Required in @(
    "transactionProtocol", "operation", "outcome", "appliedCount", "noopCount"
  )) {
    if ($Properties.Name -cnotcontains $Required) {
      throw "Client configuration response is missing $Required."
    }
  }
  $RequiredOrder = @(
    "transactionProtocol", "operation", "outcome", "appliedCount", "noopCount"
  )
  if ($Names.Count -lt $RequiredOrder.Count) {
    throw "Client configuration response is missing required fields."
  }
  for ($Index = 0; $Index -lt $RequiredOrder.Count; $Index++) {
    if ($Names[$Index] -cne $RequiredOrder[$Index]) {
      throw "Client configuration response fields are not in canonical order."
    }
  }
  $OptionalOrder = if ($Names.Count -eq 5) {
    ""
  } else {
    ($Names[5..($Names.Count - 1)] -join ",")
  }
  if (@(
        "", "disposition,authentication",
        "disposition,authentication,errorCode,message",
        "errorCode,message", "journal", "journal,errorCode,message",
        "journal,disposition,authentication",
        "journal,errorCode,message,disposition,authentication",
        "journal,disposition,authentication,errorCode,message"
      ) -cnotcontains $OptionalOrder) {
    throw "Client configuration response optional fields are not in canonical order."
  }
  if ($Value.transactionProtocol -isnot [int] -or
      $Value.transactionProtocol -ne 1 -or
      $Value.operation -isnot [string] -or
      $Value.operation -cne $ExpectedOperation -or
      $Value.outcome -isnot [string] -or
      @(
        "applied", "no-mutation", "interaction-unavailable",
        "configuration-unavailable", "authentication-incomplete",
        "failed-rolled-back", "rollback-incomplete", "conflict",
        "journal-ambiguous", "journal-persistence-unknown",
        "journal-unavailable"
      ) -cnotcontains $Value.outcome) {
    throw "Client configuration response has an invalid protocol, operation, or outcome."
  }
  foreach ($CountName in @("appliedCount", "noopCount")) {
    $Count = $Value.$CountName
    if (($Count -isnot [int] -and $Count -isnot [long]) -or $Count -lt 0) {
      throw "Client configuration response has an invalid $CountName."
    }
  }
  if ($Properties.Name -ccontains "authentication" -and
      @("not-attempted", "ready", "skipped", "retained", "unconfirmed") -cnotcontains
        $Value.authentication) {
    throw "Client configuration response has an invalid authentication state."
  }
  if ($Properties.Name -ccontains "disposition" -and
      @(
        "configured", "no-clients", "no-changes", "cancelled",
        "interaction-unavailable", "configuration-unavailable",
        "authentication-incomplete"
      ) -cnotcontains $Value.disposition) {
    throw "Client configuration response has an invalid disposition."
  }
  foreach ($StringName in @("journal", "errorCode", "message")) {
    if ($Properties.Name -ccontains $StringName -and
        ($Value.$StringName -isnot [string] -or
         [string]::IsNullOrEmpty($Value.$StringName))) {
      throw "Client configuration response has an invalid $StringName."
    }
  }
  $HasJournal = $Names -ccontains "journal"
  $HasError = $Names -ccontains "errorCode"
  $HasMessage = $Names -ccontains "message"
  if ($HasError -ne $HasMessage) {
    throw "Client configuration response has incomplete error fields."
  }
  if ($HasJournal -and $Value.journal -cne $ExpectedJournal) {
    throw "Client configuration response names an unexpected journal."
  }
  if ($Value.outcome -ceq "applied") {
    if ($Value.appliedCount -le 0 -or -not $HasJournal) {
      throw "Applied client configuration requires mutations and a journal."
    }
  } elseif ($Value.appliedCount -ne 0) {
    throw "Non-applied client configuration must report zero applied mutations."
  }
  if ($ExpectedOperation -ceq "apply") {
    if ($Names -cnotcontains "disposition" -or
        $Names -cnotcontains "authentication") {
      throw "Client configuration apply response is missing its disposition."
    }
    switch -CaseSensitive ("$ExitCode`:$($Value.outcome)") {
      "0:applied" {
        if ($Value.disposition -cne "configured" -or
            @("unconfirmed", "retained") -ccontains $Value.authentication -or
            $HasError) {
          throw "Applied client configuration response is contradictory."
        }
      }
      "0:no-mutation" {
        if ($HasJournal -or
            @("no-clients", "no-changes", "cancelled") -cnotcontains
              $Value.disposition -or
            @("unconfirmed", "retained") -ccontains $Value.authentication -or
            $HasError) {
          throw "No-mutation client configuration response is contradictory."
        }
      }
      { @(
          "1:interaction-unavailable", "1:configuration-unavailable",
          "1:authentication-incomplete", "1:failed-rolled-back",
          "1:journal-unavailable",
          "2:rollback-incomplete", "2:conflict", "2:journal-ambiguous",
          "2:journal-persistence-unknown"
        ) -ccontains $_ } {
        if (-not $HasError) {
          throw "Failed client configuration response is missing error context."
        }
        if ($Value.authentication -ceq "ready") {
          throw "Failed client configuration cannot report ready authentication."
        }
        $AllowedDisposition = switch -CaseSensitive ($Value.outcome) {
          "interaction-unavailable" { @("interaction-unavailable") }
          "configuration-unavailable" { @("configuration-unavailable") }
          "authentication-incomplete" { @("authentication-incomplete") }
          "failed-rolled-back" {
            @(
              "interaction-unavailable", "configuration-unavailable",
              "authentication-incomplete"
            )
          }
          "conflict" { @("configuration-unavailable") }
          "journal-ambiguous" { @("configuration-unavailable") }
          "journal-unavailable" { @("configuration-unavailable") }
          default {
            @(
              "interaction-unavailable", "configuration-unavailable",
              "authentication-incomplete"
            )
          }
        }
        if ($AllowedDisposition -cnotcontains $Value.disposition) {
          throw "Failed client configuration response has a contradictory disposition."
        }
      }
      default {
        throw "Client configuration response outcome does not match its exit status."
      }
    }
  } else {
    if ($Names -ccontains "disposition" -or
        $Names -ccontains "authentication") {
      throw "Client configuration rollback response contains apply-only fields."
    }
    switch -CaseSensitive ("$ExitCode`:$($Value.outcome)") {
      "0:failed-rolled-back" {
        if (-not $HasJournal -or $HasError) {
          throw "Successful client configuration rollback response is contradictory."
        }
      }
      { @(
          "1:journal-unavailable", "2:rollback-incomplete", "2:conflict",
          "2:journal-persistence-unknown"
        ) -ccontains $_ } {
        if (-not $HasError) {
          throw "Failed client configuration rollback response is missing error context."
        }
      }
      default {
        throw "Client configuration rollback outcome does not match its exit status."
      }
    }
  }
  return $Value
}

function Write-AuthenticationState([object] $Result) {
  $Authentication = if (
    $Result.PSObject.Properties.Name -ccontains "authentication"
  ) {
    [string] $Result.authentication
  } else {
    $null
  }
  switch -CaseSensitive ($Authentication) {
    "ready" { Write-Host "Sana authentication was confirmed ready." }
    "retained" { Write-Host "Existing Sana authentication was retained." }
    "unconfirmed" {
      Write-Host "Sana authentication may have been retained but could not be confirmed."
    }
    "skipped" { Write-Host "Sana authentication was not changed." }
  }
}

function Test-ConfigJournal {
  if ($null -eq $ConfigJournalFile -or
      -not (Test-Path -LiteralPath $ConfigJournalFile -PathType Leaf)) {
    return $false
  }
  Assert-NotReparse $ConfigJournalFile "Client configuration journal"
  return $true
}

function Remove-CompletedConfigJournal {
  if (Test-ConfigJournal) {
    Remove-Item -LiteralPath $ConfigJournalFile -Force
  } elseif (Test-Path -LiteralPath $ConfigJournalFile) {
    throw "Client configuration journal is not a regular file."
  }
  if (Test-Path -LiteralPath $ConfigJournalDir) {
    Assert-NotReparse $ConfigJournalDir "Client configuration journal directory"
    Remove-Item -LiteralPath $ConfigJournalDir -Force
  }
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
  [bool] $OwnsInstallLock,
  [AllowNull()] [string] $OwnedInstallLock,
  [bool] $OwnsPathLock,
  [AllowNull()] [string] $OwnedPathLock,
  [bool] $KeepTemporary,
  [AllowNull()] [string] $TemporaryDirectory
) {
  $Failures = @()
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
    "lifecycleProtocol", "semanticCapability"
  )
  foreach ($Key in @(
    "inspectProtocol", "version", "target", "installerProtocol",
    "lifecycleProtocol", "semanticCapability"
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

  $DestinationExists = Test-Path -LiteralPath $Destination -PathType Leaf
  $ReceiptExists = Test-Path -LiteralPath $ReceiptPath -PathType Leaf
  if ($DestinationExists -and -not $ReceiptExists) {
    $LegacyRelease = Get-VerifiedLegacyRelease $Destination
    $OldPresent = $true
    $LegacyInstall = $true
    $OldWasRunning =
      @(Get-LegacyDaemonProcesses $Destination).Count -gt 0
    $OldBinaryBackup = Join-Path $TempDir "previous-sana-mcp.exe"
    Copy-Item -LiteralPath $Destination -Destination $OldBinaryBackup
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
    if ((Get-Sha256 $Destination) -cne $OldReceipt["binarySha256"]) {
      throw "The existing binary no longer matches its installer receipt."
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
      "lifecycleProtocol", "semanticCapability"
    )
    foreach ($Key in @(
      "inspectProtocol", "version", "target", "installerProtocol",
      "lifecycleProtocol", "semanticCapability"
    )) {
      if (-not $OldInspect.ContainsKey($Key)) {
        throw "The existing binary inspection is missing $Key."
      }
    }
    if ($OldInspect["inspectProtocol"] -cne "1" -or
        $OldInspect["installerProtocol"] -cne "1" -or
        $OldInspect["lifecycleProtocol"] -cne "1" -or
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
  }

  $StagedBinary = Join-Path $InstallDir (".sana-mcp-" + [Guid]::NewGuid().ToString("N") + ".exe")
  Copy-Item -LiteralPath $Binary -Destination $StagedBinary
  if ((Get-Sha256 $StagedBinary) -cne $Release["sha256"]) {
    throw "Staged binary checksum changed before installation."
  }

  $PathLockRoot = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
  )
  if ([string]::IsNullOrWhiteSpace($PathLockRoot)) {
    throw "Windows did not provide an authoritative per-user directory for installer serialization."
  }
  $PathLock = Join-Path $PathLockRoot ".sana-mcp-installer-path.lock"
  if (Test-Path -LiteralPath $PathLock) {
    throw "Another sana-mcp installer is changing user state, or a stale lock needs removal: $PathLock"
  }
  New-Item -ItemType Directory -Path $PathLock | Out-Null
  $PathLockAcquired = $true

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

  Move-Item -LiteralPath $StagedBinary -Destination $Destination -Force
  $StagedBinary = $null

  $OldUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $UserEntries = if ([string]::IsNullOrEmpty($OldUserPath)) {
    @()
  } else {
    @($OldUserPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }
  $NormalizedInstallDir = Normalize-PathEntry $InstallDir
  $MatchingEntries = @(
    $UserEntries | Where-Object { (Normalize-PathEntry $_) -eq $NormalizedInstallDir }
  )
  if ($MatchingEntries.Count -gt 1) {
    throw "The user PATH contains duplicate entries for $InstallDir; remove the duplicates before installing."
  }
  if ($OldPresent -and -not $LegacyInstall) {
    if ($NewPathManaged -and $MatchingEntries.Count -ne 1) {
      throw "The installer-owned PATH entry recorded by the receipt is missing."
    }
  } else {
    $NewPathManaged = $MatchingEntries.Count -eq 0
  }

  if ($NewPathManaged -and $MatchingEntries.Count -eq 0) {
    $NewUserPath = if ([string]::IsNullOrEmpty($OldUserPath)) {
      $InstallDir
    } else {
      "$OldUserPath;$InstallDir"
    }
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
    Write-Host "Added $InstallDir to PATH for new shells."
  } elseif ($MatchingEntries.Count -eq 1) {
    Write-Host "Verified $InstallDir is already on PATH for new shells."
  }

  $ExpectedCurrentUserPath = if ($PathChanged) {
    $WrittenUserPath
  } else {
    $OldUserPath
  }
  if (
    [Environment]::GetEnvironmentVariable("Path", "User") -cne
      $ExpectedCurrentUserPath
  ) {
    throw "The user PATH changed before the installer receipt was published."
  }

  $StagedReceipt = Join-Path $InstallDir (".sana-mcp-receipt-" + [Guid]::NewGuid().ToString("N"))
  $ReceiptBody = @(
    "format=sana-mcp-install-v1"
    "version=$($Release["packageVersion"])"
    "target=$($Release["target"])"
    "sourceCommit=$($Release["sourceCommit"])"
    "binarySha256=$($Release["sha256"])"
    "pathManaged=$($NewPathManaged.ToString().ToLowerInvariant())"
  ) -join "`n"
  [IO.File]::WriteAllText($StagedReceipt, "$ReceiptBody`n", [Text.Encoding]::ASCII)
  Move-Item -LiteralPath $StagedReceipt -Destination $ReceiptPath -Force
  $StagedReceipt = $null

  $AuthMigrationOutput = @(
    & $Destination __migrate-legacy-auth --format properties
  )
  $AuthMigrationExit = $LASTEXITCODE
  if ($AuthMigrationExit -ne 0) {
    # The command may have opened or migrated the local store before failing.
    $LiveStateTouched = $true
    throw "Legacy Sana authentication migration failed (exit $AuthMigrationExit). The replacement runtime was retained."
  }
  $AuthMigrationFile = Join-Path $TempDir "auth-migration.properties"
  [IO.File]::WriteAllText(
    $AuthMigrationFile,
    (($AuthMigrationOutput -join "`n") + "`n"),
    [Text.Encoding]::ASCII
  )
  $AuthMigration = Read-Properties $AuthMigrationFile @(
    "migrationProtocol", "state", "persistentStateTouched"
  )
  foreach ($Key in @(
    "migrationProtocol", "state", "persistentStateTouched"
  )) {
    if (-not $AuthMigration.ContainsKey($Key)) {
      $LiveStateTouched = $true
      throw "Legacy Sana authentication migration response is missing $Key."
    }
  }
  if ($AuthMigration["migrationProtocol"] -cne "1" -or
      @(
        "not-needed", "preserved", "fresh-login-required",
        "validation-unavailable", "local-session-unavailable"
      ) -cnotcontains $AuthMigration["state"] -or
      @("true", "false") -cnotcontains
        $AuthMigration["persistentStateTouched"]) {
    $LiveStateTouched = $true
    throw "Legacy Sana authentication migration returned an invalid response."
  }
  $AuthMigrationState = $AuthMigration["state"]
  $AuthStateTouched =
    $AuthMigration["persistentStateTouched"] -ceq "true"
  if (
    ($AuthStateTouched -and @(
      "preserved", "fresh-login-required"
    ) -cnotcontains $AuthMigrationState) -or
    (-not $AuthStateTouched -and @(
      "not-needed", "validation-unavailable",
      "local-session-unavailable"
    ) -cnotcontains $AuthMigrationState)
  ) {
    $LiveStateTouched = $true
    throw "Legacy Sana authentication migration response is contradictory."
  }
  if ($AuthStateTouched) {
    $LiveStateTouched = $true
  }
  switch -CaseSensitive ($AuthMigrationState) {
    "preserved" {
      Write-Host "Existing Sana authentication was revalidated and preserved."
    }
    "fresh-login-required" {
      Write-Host "The previous Sana session could not be preserved; sign in again during setup."
    }
    "validation-unavailable" {
      throw "Existing Sana authentication could not be validated because Sana is unavailable. The previous runtime and unchanged session were restored; rerun the installer when Sana is reachable."
    }
    "local-session-unavailable" {
      throw "Existing Sana authentication could not be read safely. The previous runtime and unchanged session were restored; repair the reported session path and rerun the installer."
    }
  }

  $ConfigJournalDir = Join-Path $InstallDir ".sana-mcp-config-transaction"
  $ConfigJournalFile = Join-Path $ConfigJournalDir "client-config-transaction.json"
  Assert-NotReparse $ConfigJournalDir "Client configuration journal directory"
  $ConfigJournalPreexisting = Test-Path -LiteralPath $ConfigJournalFile
  $ConfigInteractiveAttempted = $false
  if ($env:SANA_MCP_YES -eq "1") {
    $LiveStateTouched = $true
    $ConfigOutput = @(
      & $Destination __configure-transaction apply `
        --journal $ConfigJournalDir `
        --server-command $Destination `
        --yes
    )
    $ConfigureExit = $LASTEXITCODE
  } elseif ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    $ConfigInteractiveAttempted = $true
    $LiveStateTouched = $true
    $ConfigOutput = @(
      & $Destination __configure-transaction apply `
        --journal $ConfigJournalDir `
        --server-command $Destination
    )
    $ConfigureExit = $LASTEXITCODE
  } else {
    Write-Host "Client configuration was skipped because no interactive terminal is available."
    Write-Host "Run this command: $(Format-InstallCommand $Destination)"
    $ConfigTransactionState = "no-mutation"
    $ConfigureExit = 0
  }
  if ($ConfigTransactionState -cne "no-mutation") {
    try {
      $ConfigResult = Read-ConfigTransactionResult `
        $ConfigOutput "apply" $ConfigureExit $ConfigJournalFile
    } catch {
      $RetainNewRuntime = $true
      $PreserveTemp = $true
      throw "$($_.Exception.Message) The replacement runtime and recovery files were retained."
    }
    if ($ConfigureExit -eq 1 -and
        $ConfigInteractiveAttempted -and
        $ConfigResult.outcome -ceq "interaction-unavailable" -and
        $ConfigResult.appliedCount -eq 0 -and
        $ConfigResult.noopCount -eq 0 -and
        $ConfigResult.disposition -ceq "interaction-unavailable" -and
        $ConfigResult.authentication -ceq "not-attempted" -and
        $ConfigResult.errorCode -ceq
          "CONFIG_TRANSACTION_INTERACTION_UNAVAILABLE" -and
        $ConfigResult.message -ceq
          "an interactive terminal is required for client selection" -and
        -not $ConfigJournalPreexisting -and
        -not (Test-Path -LiteralPath $ConfigJournalFile)) {
      $ConfigTransactionState = "no-mutation"
      Write-Host "Client configuration was deferred because interactive controls are unavailable."
      Write-Host "Run this command: $(Format-InstallCommand $Destination)"
    } elseif ($ConfigureExit -eq 0 -and $ConfigResult.outcome -ceq "applied") {
      Write-AuthenticationState $ConfigResult
      if ($ConfigJournalPreexisting -or -not (Test-ConfigJournal)) {
        $RetainNewRuntime = $true
        $PreserveTemp = $true
        throw "Client configuration reported applied changes without a usable recovery journal. The replacement runtime was retained."
      }
      $ConfigTransactionState = "applied"
    } elseif ($ConfigureExit -eq 0 -and $ConfigResult.outcome -ceq "no-mutation") {
      Write-AuthenticationState $ConfigResult
      if (Test-Path -LiteralPath $ConfigJournalFile) {
        $RetainNewRuntime = $true
        $PreserveTemp = $true
        throw "Client configuration reported no changes but left a recovery journal. The replacement runtime was retained."
      }
      $ConfigTransactionState = "no-mutation"
    } elseif ($ConfigureExit -eq 1 -and
              $ConfigResult.outcome -ceq "failed-rolled-back") {
      Write-AuthenticationState $ConfigResult
      $ConfigTransactionState = "safe-rolled-back"
      try {
        Remove-CompletedConfigJournal
      } catch {
        [Console]::Error.WriteLine(
          "sana-mcp: client configuration was rolled back, but its completed journal could not be removed: $ConfigJournalDir"
        )
      }
      $PreserveTemp = $true
      throw "Client configuration did not complete, but its changes were rolled back. The replacement runtime remains installed because it has accessed live state."
    } elseif ($ConfigureExit -eq 1 -and
              @(
                "interaction-unavailable", "configuration-unavailable",
                "authentication-incomplete", "no-mutation"
              ) -ccontains $ConfigResult.outcome) {
      Write-AuthenticationState $ConfigResult
      if ($ConfigJournalPreexisting -or
          -not (Test-Path -LiteralPath $ConfigJournalFile)) {
        $ConfigTransactionState = "no-mutation"
        $PreserveTemp = $true
        throw "Client configuration did not complete before changing client files. The replacement runtime remains installed because it has accessed live state."
      }
      $RetainNewRuntime = $true
      $PreserveTemp = $true
      throw "Client configuration did not complete and may have changed client files. The replacement runtime and recovery journal were retained."
    } elseif ($ConfigureExit -eq 1 -and $ConfigJournalPreexisting) {
      Write-AuthenticationState $ConfigResult
      $ConfigTransactionState = "no-mutation"
      $PreserveTemp = $true
      throw "Client configuration could not start while an existing recovery journal is present. The replacement runtime and existing journal were preserved."
    } else {
      Write-AuthenticationState $ConfigResult
      $RetainNewRuntime = $true
      $PreserveTemp = $true
      throw "Client configuration rollback status is uncertain (exit $ConfigureExit, outcome $($ConfigResult.outcome)). The replacement runtime and recovery journal were retained."
    }
  }

  $LiveStateTouched = $true
  if ($OldWasRunning) {
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

  $Committed = $true
  $TransactionActive = $false
  if ($ConfigTransactionState -ceq "applied") {
    try {
      Remove-CompletedConfigJournal
      $ConfigTransactionState = "no-mutation"
    } catch {
      [Console]::Error.WriteLine(
        "sana-mcp: install succeeded, but the completed configuration journal could not be removed: $ConfigJournalDir"
      )
    }
  }
  Write-Host "Installed $Destination"
  if (-not $NewPathManaged -and $MatchingEntries.Count -eq 0) {
    Write-Host "Add $InstallDir to PATH to run sana-mcp from new shells."
  }
} catch {
  $InstallError = $_.Exception.Message
  $RollbackErrors = @()
  if ($TransactionActive -and -not $Committed) {
    $CanRestoreFiles = -not $RetainNewRuntime -and -not $LiveStateTouched
    $FilesRestored = $false
    if ($LiveStateTouched) {
      $RetainNewRuntime = $true
      $PreserveTemp = $true
      if ($ConfigTransactionState -ceq "applied") {
        try {
          $RollbackOutput = @(
            & $Destination __configure-transaction rollback --journal $ConfigJournalDir
          )
          $ConfigRollbackExit = $LASTEXITCODE
          $ConfigRollbackResult = Read-ConfigTransactionResult `
            $RollbackOutput "rollback" $ConfigRollbackExit $ConfigJournalFile
          if ($ConfigRollbackExit -ne 0 -or
              $ConfigRollbackResult.outcome -cne "failed-rolled-back") {
            throw "Client configuration rollback returned exit $ConfigRollbackExit and outcome $($ConfigRollbackResult.outcome)."
          }
          $ConfigTransactionState = "safe-rolled-back"
          try {
            Remove-CompletedConfigJournal
          } catch {
            $RollbackErrors += "could not remove the completed client configuration journal: $($_.Exception.Message)"
          }
        } catch {
          $RollbackErrors += "client configuration rollback was incomplete: $($_.Exception.Message)"
        }
      }
      try {
        Set-RetainedRuntimeState
      } catch {
        $RollbackErrors += $_.Exception.Message
      }
    } elseif ($RetainNewRuntime) {
      try {
        Set-RetainedRuntimeState
      } catch {
        $RollbackErrors += $_.Exception.Message
      }
    }
    if ($CanRestoreFiles) {
      try {
        if ($OldPresent) {
          if ($null -eq $OldBinaryBackup -or -not (Test-Path -LiteralPath $OldBinaryBackup -PathType Leaf)) {
            throw "previous binary backup is unavailable"
          }
          $StagedBinary = Join-Path $InstallDir (".sana-mcp-rollback-" + [Guid]::NewGuid().ToString("N") + ".exe")
          Copy-Item -LiteralPath $OldBinaryBackup -Destination $StagedBinary
          Move-Item -LiteralPath $StagedBinary -Destination $Destination -Force
          $StagedBinary = $null
          if ($LegacyInstall) {
            if (Test-Path -LiteralPath $ReceiptPath) {
              Remove-Item -LiteralPath $ReceiptPath -Force
            }
          } else {
            if ($null -eq $OldReceiptBackup -or -not (Test-Path -LiteralPath $OldReceiptBackup -PathType Leaf)) {
              throw "previous receipt backup is unavailable"
            }
            $StagedReceipt = Join-Path $InstallDir (".sana-mcp-receipt-rollback-" + [Guid]::NewGuid().ToString("N"))
            Copy-Item -LiteralPath $OldReceiptBackup -Destination $StagedReceipt
            Move-Item -LiteralPath $StagedReceipt -Destination $ReceiptPath -Force
            $StagedReceipt = $null
          }
        } else {
          if ($null -ne $Destination -and (Test-Path -LiteralPath $Destination)) {
            Remove-Item -LiteralPath $Destination -Force
          }
          if ($null -ne $ReceiptPath -and (Test-Path -LiteralPath $ReceiptPath)) {
            Remove-Item -LiteralPath $ReceiptPath -Force
          }
        }
        $FilesRestored = $true
      } catch {
        $RollbackErrors += "could not restore installed files: $($_.Exception.Message)"
      }
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
      } catch {
        $RollbackErrors += "could not restart the previous runtime: $($_.Exception.Message)"
      }
    }
    if ($RetainNewRuntime) {
      [Console]::Error.WriteLine(
        "sana-mcp: retained the replacement runtime at $Destination"
      )
      try {
        if ($null -ne $ConfigJournalFile -and
            (Test-Path -LiteralPath $ConfigJournalFile)) {
          [Console]::Error.WriteLine(
            "sana-mcp: client configuration recovery journal: $ConfigJournalDir"
          )
        }
      } catch {
        $RollbackErrors += "could not inspect the client configuration recovery journal: $($_.Exception.Message)"
      }
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
  $CleanupErrors = @(
    Invoke-InstallerCleanup `
      $StagedBinary `
      $StagedReceipt `
      $LockAcquired `
      $InstallLock `
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
