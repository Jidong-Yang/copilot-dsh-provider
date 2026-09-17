#requires -Version 7.4
[CmdletBinding()]
param([switch]$ForceAuth)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = $PSScriptRoot
$manifestPath = Join-Path $projectRoot "package.json"
foreach ($requiredPath in @($manifestPath, (Join-Path $projectRoot "bun.lock"), (Join-Path $projectRoot "src/main.ts"))) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required provider artifact is missing: $requiredPath"
    }
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -cne "copilot-dsh-provider" -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Unexpected provider package identity or version."
}
Write-Host "Preparing $($manifest.name) version $($manifest.version)."

function Resolve-Bun {
    $command = Get-Command bun -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    Write-Host "Bun is not installed. Installing Bun for the current user..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -Command "irm bun.sh/install.ps1|iex"
    if ($LASTEXITCODE -ne 0) {
        throw "Bun installation failed with exit code $LASTEXITCODE."
    }

    $installedPath = Join-Path $HOME ".bun\bin\bun.exe"
    if (-not (Test-Path -LiteralPath $installedPath)) {
        throw "Bun installation completed but bun.exe was not found at $installedPath."
    }
    return $installedPath
}

function Get-ProviderHealth {
    param([Parameter(Mandatory)][string]$BunPath)

    $output = & $BunPath run src/main.ts auth-status 2>$null
    $exitCode = $LASTEXITCODE
    $health = $null
    try {
        $health = $output | Select-Object -Last 1 | ConvertFrom-Json
    } catch {
        throw "Unable to determine provider authentication status."
    }
    return @{
        ExitCode = $exitCode
        Health = $health
    }
}

$bun = Resolve-Bun
Write-Host "Using Bun: $bun"

Push-Location $projectRoot
try {
    Write-Host "Installing project dependencies..."
    & $bun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
        throw "bun install failed with exit code $LASTEXITCODE."
    }

    $requiresAuth = $ForceAuth
    if (-not $requiresAuth) {
        $status = Get-ProviderHealth -BunPath $bun
        if ($status.Health.status -eq "ready") {
            Write-Host "Existing GitHub Copilot credential is healthy."
        } elseif ($status.Health.status -eq "reauth-required") {
            $requiresAuth = $true
        } else {
            throw "GitHub is temporarily unavailable; authentication was not replaced. Retry setup later."
        }
    }

    if ($requiresAuth) {
        if ($env:COPILOT_GITHUB_TOKEN) {
            throw "COPILOT_GITHUB_TOKEN is set and overrides stored credentials. Remove it before interactive authentication."
        }
        Write-Host "Starting GitHub Device Flow authentication..."
        & $bun run src/main.ts auth
        if ($LASTEXITCODE -ne 0) {
            throw "GitHub authentication failed with exit code $LASTEXITCODE."
        }
        $status = Get-ProviderHealth -BunPath $bun
        if ($status.Health.status -ne "ready") {
            throw "The new GitHub credential could not access GitHub Copilot."
        }
    }

    Write-Host "Install-only preparation complete. No Scheduled Task or process was changed."
} finally {
    Pop-Location
}
