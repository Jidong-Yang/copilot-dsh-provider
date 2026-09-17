#requires -Version 7.4
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$sourcePath = Join-Path $PSScriptRoot "../setup.ps1"
$source = Get-Content -LiteralPath $sourcePath -Raw
foreach ($required in @(
    '[string]$TaskName = "Copilot DSH Provider"',
    'New-ScheduledTaskTrigger -AtLogOn -User $identity',
    '-StartWhenAvailable',
    '-AllowStartIfOnBatteries',
    '-DontStopIfGoingOnBatteries',
    '-ExecutionTimeLimit ([TimeSpan]::Zero)',
    '-RestartCount 999',
    '-RestartInterval (New-TimeSpan -Minutes 1)',
    '-MultipleInstances IgnoreNew',
    '-LogonType Interactive',
    '-RunLevel Highest',
    'Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue',
    'Register-ScheduledTask',
    'Start-ScheduledTask -TaskName $TaskName'
)) {
    Assert-True ($source.Contains($required, [StringComparison]::Ordinal)) "Standalone task behavior changed: $required"
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
    $bad = Get-Content -LiteralPath (Join-Path $fixture "package.json") -Raw | ConvertFrom-Json
    $bad.name = "unexpected-provider"
    $bad | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $fixture "package.json")
    $rejected = $false
    try { & (Join-Path $fixture "setup.ps1") -InstallOnly } catch { $rejected = $_.Exception.Message -eq "Unexpected provider package identity or version." }
    Assert-True $rejected "InstallOnly accepted an unexpected package identity"
    Assert-True (-not (Test-Path -LiteralPath $log)) "Artifact validation ran Bun before rejecting the package"

    Write-Output "PASS install-only preparation is isolated from elevation, tasks, and process control; standalone task specification is unchanged"
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
