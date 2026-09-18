#requires -Version 7.4
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Normalize-Newlines([string]$Text) {
    return ($Text -replace "\r\n?", "`n").TrimEnd("`n")
}

$sourcePath = Join-Path $PSScriptRoot "../setup.ps1"
$installOnlyPath = Join-Path $PSScriptRoot "../setup-install-only.ps1"
$source = Get-Content -LiteralPath $sourcePath -Raw
$installOnlySource = Get-Content -LiteralPath $installOnlyPath -Raw
$marker = '$pwsh = Resolve-PowerShell7'
$markerIndex = $source.IndexOf($marker, [StringComparison]::Ordinal)
Assert-True ($markerIndex -ge 0) "Standalone setup boundary is missing"
$actualStandalone = Normalize-Newlines $source.Substring($markerIndex)
$expectedStandalone = Normalize-Newlines (Get-Content -LiteralPath (Join-Path $PSScriptRoot "setup-standalone.expected.ps1") -Raw)
Assert-True ($actualStandalone -ceq $expectedStandalone) "Default standalone control flow differs from the canonical setup"

$prefix = $source.Substring(0, $markerIndex)
$dispatch = @'
if ($InstallOnly) {
    & (Join-Path $projectRoot "setup-install-only.ps1") -ForceAuth:$ForceAuth
    return
}
'@
Assert-True ((Normalize-Newlines $prefix).Contains((Normalize-Newlines $dispatch), [StringComparison]::Ordinal)) "InstallOnly does not return before standalone setup"
Assert-True (-not $prefix.Contains('$manifestPath', [StringComparison]::Ordinal)) "Artifact validation became an unconditional setup precheck"
foreach ($forbidden in @(
    "Start-Process", "Stop-Process", "New-ScheduledTask", "Get-ScheduledTask",
    "Stop-ScheduledTask", "Register-ScheduledTask", "Unregister-ScheduledTask",
    "Start-ScheduledTask", "taskkill", "TerminateProcess"
)) {
    Assert-True (-not $installOnlySource.Contains($forbidden, [StringComparison]::OrdinalIgnoreCase)) "Install-only source contains forbidden lifecycle operation: $forbidden"
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("copilot-setup-test-" + [guid]::NewGuid().ToString("N"))
$fixture = Join-Path $root "provider"
$bin = Join-Path $root "bin"
$log = Join-Path $root "bun-calls.txt"
$oldPath = $env:PATH
$oldLog = $env:COPILOT_SETUP_TEST_LOG

function global:Start-Process { throw "InstallOnly reached Start-Process" }
function global:Stop-Process { throw "InstallOnly reached Stop-Process" }
function global:New-ScheduledTaskAction { throw "InstallOnly reached New-ScheduledTaskAction" }
function global:New-ScheduledTaskTrigger { throw "InstallOnly reached New-ScheduledTaskTrigger" }
function global:New-ScheduledTaskSettingsSet { throw "InstallOnly reached New-ScheduledTaskSettingsSet" }
function global:New-ScheduledTaskPrincipal { throw "InstallOnly reached New-ScheduledTaskPrincipal" }
function global:Get-ScheduledTask { throw "InstallOnly reached Get-ScheduledTask" }
function global:Stop-ScheduledTask { throw "InstallOnly reached Stop-ScheduledTask" }
function global:Register-ScheduledTask { throw "InstallOnly reached Register-ScheduledTask" }
function global:Unregister-ScheduledTask { throw "InstallOnly reached Unregister-ScheduledTask" }
function global:Start-ScheduledTask { throw "InstallOnly reached Start-ScheduledTask" }

try {
    $null = New-Item -ItemType Directory -Path (Join-Path $fixture "src"), $bin -Force
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $fixture "setup.ps1")
    Copy-Item -LiteralPath $installOnlyPath -Destination (Join-Path $fixture "setup-install-only.ps1")
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../package.json") -Destination $fixture
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../bun.lock") -Destination $fixture
    Set-Content -LiteralPath (Join-Path $fixture "src/main.ts") -Value "// fixture" -NoNewline
    @'
@echo off
>>"%COPILOT_SETUP_TEST_LOG%" echo %*
if "%1"=="run" if "%3"=="auth-status" echo {"status":"ready"}
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $bin "bun.cmd") -Encoding ascii

    $env:PATH = $bin + [IO.Path]::PathSeparator + $oldPath
    $env:COPILOT_SETUP_TEST_LOG = $log
    & (Join-Path $fixture "setup.ps1") -InstallOnly

    $calls = @(Get-Content -LiteralPath $log)
    Assert-True ($calls.Count -eq 2) "InstallOnly invoked unexpected Bun commands"
    Assert-True ($calls[0] -ceq "install --frozen-lockfile") "InstallOnly did not use the locked dependency install"
    Assert-True ($calls[1] -ceq "run src/main.ts auth-status") "InstallOnly did not validate the existing credential"

    Remove-Item -LiteralPath $log
    $manifestPath = Join-Path $fixture "package.json"
    $originalManifest = Get-Content -LiteralPath $manifestPath -Raw
    $bad = $originalManifest | ConvertFrom-Json
    $bad.name = "unexpected-provider"
    $bad | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath
    $rejected = $false
    try { & (Join-Path $fixture "setup.ps1") -InstallOnly } catch { $rejected = $_.Exception.Message -eq "Unexpected provider package identity or version." }
    Assert-True $rejected "InstallOnly accepted an unexpected package identity"
    Assert-True (-not (Test-Path -LiteralPath $log)) "Malformed artifact validation ran Bun"

    Set-Content -LiteralPath $manifestPath -Value $originalManifest -NoNewline
    Remove-Item -LiteralPath (Join-Path $fixture "bun.lock")
    $rejected = $false
    try { & (Join-Path $fixture "setup.ps1") -InstallOnly } catch { $rejected = $_.Exception.Message.StartsWith("Required provider artifact is missing:", [StringComparison]::Ordinal) }
    Assert-True $rejected "InstallOnly accepted a missing required artifact"
    Assert-True (-not (Test-Path -LiteralPath $log)) "Missing artifact validation ran Bun"

    Write-Output "PASS install-only artifacts and lifecycle isolation; exact standalone control flow unchanged"
} finally {
    $env:PATH = $oldPath
    $env:COPILOT_SETUP_TEST_LOG = $oldLog
    foreach ($name in @(
        "Start-Process", "Stop-Process", "New-ScheduledTaskAction", "New-ScheduledTaskTrigger",
        "New-ScheduledTaskSettingsSet", "New-ScheduledTaskPrincipal", "Get-ScheduledTask",
        "Stop-ScheduledTask", "Register-ScheduledTask", "Unregister-ScheduledTask", "Start-ScheduledTask"
    )) { Remove-Item -LiteralPath ("Function:\global:" + $name) -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
