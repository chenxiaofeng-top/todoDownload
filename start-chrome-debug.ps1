[CmdletBinding()]
param([switch]$Diagnose)

$ErrorActionPreference = 'Stop'
$port = 9222
$endpoint = "http://127.0.0.1:$port"
$profile = Join-Path $PSScriptRoot '.chrome-debug'
$ownerFile = Join-Path $profile 'todo-debug-owner.json'

function Get-DebugListeners {
    $lines = & "$env:SystemRoot\System32\netstat.exe" -ano
    if ($LASTEXITCODE -ne 0) { throw 'Could not check the local TCP port.' }
    foreach ($line in $lines) {
        if ($line -match "^\s*TCP\s+(\S+):$port\s+\S+:0\s+\S+\s+(\d+)\s*$") {
            [pscustomobject]@{ Address = $Matches[1]; ProcessId = [int]$Matches[2] }
        }
    }
}

function Get-DebugChrome($Launched) {
    $listeners = @(Get-DebugListeners)
    if (!$listeners.Count) { return }
    $owners = @($listeners.ProcessId | Select-Object -Unique)
    $addresses = @($listeners | ForEach-Object { $_.Address })
    if ($owners.Count -ne 1 -or !($addresses -contains '127.0.0.1') -or
        @($addresses | Where-Object { $_ -notin '127.0.0.1', '[::1]' }).Count) {
        throw "Port $port is occupied or does not listen exclusively on loopback (listeners: $($addresses -join ', '))."
    }

    $process = Get-Process -Id $owners[0]
    $startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
    $previous = if (Test-Path -LiteralPath $ownerFile -PathType Leaf) {
        Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
    }
    $sameLaunch = $Launched -and $process.Id -eq $Launched.Id -and $process.StartTime -eq $Launched.StartTime
    $knownOwner = $previous -and $process.Id -eq $previous.ProcessId -and $startTicks -eq $previous.StartTicks
    if ($process.ProcessName -eq 'chrome' -and !($sameLaunch -or $knownOwner)) {
        $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue).CommandLine
        $profileArg = [regex]::Escape("--user-data-dir=$profile")
        $knownOwner = $commandLine -match "(?:^|\s)(?:`"$profileArg`"|$profileArg)(?:\s|$)"
    }
    if ($process.ProcessName -ne 'chrome' -or !($sameLaunch -or $knownOwner)) {
        throw "Port $port is occupied by a process outside this project's Chrome profile."
    }

    $version = Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2
    if ($version.Browser -notmatch '^Chrome/' -or
        $version.webSocketDebuggerUrl -notmatch "^ws://127\.0\.0\.1:$port/devtools/browser/[\w-]+$") {
        throw "Port $port did not return the expected Chrome DevTools endpoint."
    }
    @{ ProcessId = $process.Id; StartTicks = $startTicks } | ConvertTo-Json |
        Set-Content -LiteralPath $ownerFile -Encoding UTF8
    $process
}

$browser = Get-DebugChrome
if (!$browser) {
    $chrome = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) |
        Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Google\Chrome\Application\chrome.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (!$chrome) { throw 'Google Chrome was not found in its standard install locations.' }

    $started = Start-Process -FilePath $chrome -ArgumentList @(
        "--remote-debugging-port=$port", '--remote-debugging-address=127.0.0.1',
        "`"--user-data-dir=$profile`"", '--no-first-run', 'chrome://extensions/'
    ) -WindowStyle Normal -PassThru
    for ($attempt = 0; $attempt -lt 40 -and !$browser; $attempt++) {
        Start-Sleep -Milliseconds 250
        $browser = Get-DebugChrome $started
    }
    if (!$browser) {
        if ($started.HasExited) { throw "Chrome exited before listening on $endpoint (exit code $($started.ExitCode))." }
        throw "Chrome did not start listening on $endpoint. Check whether this profile is already open without debugging."
    }
    # Keep the original process handle when possible so we can recover its exit code.
    if ($browser.Id -eq $started.Id) { $browser = $started }
}

Write-Host "Chrome CDP: $endpoint (PID $($browser.Id))"
if ($Diagnose) {
    $diagnosisStarted = Get-Date
    & node (Join-Path $PSScriptRoot 'diagnose-chrome.mjs') $browser.Id
    $result = $LASTEXITCODE
    if ($browser.HasExited) {
        try { Write-Host "Chrome exit code: $($browser.ExitCode)" } catch { Write-Host 'Chrome exit code unavailable.' }
        $filter = @{ LogName = 'Application'; Id = 1000, 1001, 1002; StartTime = $diagnosisStarted }
        Get-WinEvent -FilterHashtable $filter -ErrorAction SilentlyContinue |
            Where-Object { $_.Properties.Value -contains 'chrome.exe' } |
            Select-Object TimeCreated, Id, ProviderName | Format-Table
    }
    exit $result
}
