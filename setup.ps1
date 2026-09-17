[CmdletBinding()]
param(
    [string]$TaskName = "Copilot DSH Provider",
    [switch]$ForceAuth,
    [switch]$InstallOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = $PSScriptRoot
if (-not $projectRoot) {
    throw "Unable to determine the project directory."
}

function Resolve-PowerShell7 {
    $command = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "PowerShell 7 is required. Install it from https://aka.ms/powershell-release?tag=stable."
    }
    return $command.Source
}

function Test-IsAdministrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole(
        [System.Security.Principal.WindowsBuiltInRole]::Administrator
    )
}

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

$pwsh = Resolve-PowerShell7
if (-not $InstallOnly -and -not (Test-IsAdministrator)) {
    Write-Host "Requesting elevation to register the visible startup task..."
    $arguments = @(
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-TaskName", "`"$TaskName`""
    )
    if ($ForceAuth) {
        $arguments += "-ForceAuth"
    }
    $process = Start-Process `
        -FilePath $pwsh `
        -ArgumentList $arguments `
        -Verb RunAs `
        -Wait `
        -PassThru
    exit $process.ExitCode
}

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

    if ($InstallOnly) {
        Write-Host "Install-only preparation complete. No Scheduled Task or process was changed."
        return
    }

    Write-Host "Registering Task Scheduler task '$TaskName'..."
    $escapedProjectRoot = $projectRoot.Replace("'", "''")
    $escapedBun = $bun.Replace("'", "''")
    $providerCommand = @(
        "`$Host.UI.RawUI.WindowTitle = 'Copilot DSH Provider'"
        "Set-Location -LiteralPath '$escapedProjectRoot'"
        "& '$escapedBun' run src/main.ts start"
        "exit `$LASTEXITCODE"
    ) -join "; "
    $action = New-ScheduledTaskAction `
        -Execute $pwsh `
        -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -Command `"$providerCommand`"" `
        -WorkingDirectory $projectRoot
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal `
        -UserId $identity `
        -LogonType Interactive `
        -RunLevel Highest

    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "Visible elevated PowerShell 7 host for the local Copilot provider." `
        -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $task = Get-ScheduledTask -TaskName $TaskName
        try {
            $health = Invoke-RestMethod `
                -Uri "http://127.0.0.1:4141/health" `
                -TimeoutSec 2
        } catch {
            $health = $null
        }
    } while (
        [DateTime]::UtcNow -lt $deadline `
        -and ($task.State -ne "Running" -or $null -eq $health)
    )

    if ($task.State -ne "Running") {
        throw "The scheduled task did not stay running. Port 4141 may already be in use."
    }
    if ($null -eq $health -or $health.status -ne "ready") {
        throw "The scheduled provider did not report ready at http://127.0.0.1:4141/health."
    }

    Write-Host "Setup complete. The provider is ready at http://127.0.0.1:4141."
} finally {
    Pop-Location
}
