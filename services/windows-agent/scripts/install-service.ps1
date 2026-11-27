<#
.SYNOPSIS
    Installs (or removes) the OG HOST Windows Agent as a Windows Service.

.DESCRIPTION
    Running the agent as a service means it reconnects automatically after a
    Windows restart, without anyone logging in. Minecraft servers themselves do
    NOT auto-start unless you explicitly enabled that in the panel and set
    HonorAutoStart in config.json.

    Run this script from an ELEVATED PowerShell prompt (Run as administrator).

.EXAMPLE
    .\install-service.ps1
    .\install-service.ps1 -ExePath "C:\OGHOST\OGHost.Agent.exe"
    .\install-service.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [string] $ServiceName = "OGHostAgent",
    [string] $DisplayName = "OG HOST Agent",
    [string] $Description = "Connects this computer to OG HOST as a private Minecraft Bedrock hosting node. Outbound HTTPS only; listens on no ports.",
    [string] $ExePath,
    [switch] $Uninstall
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "This script must be run from an elevated PowerShell prompt (Run as administrator)."
    }
}

Assert-Admin

if ($Uninstall) {
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Host "Service '$ServiceName' is not installed." -ForegroundColor Yellow
        return
    }
    if ($existing.Status -eq "Running") { Stop-Service -Name $ServiceName -Force }
    sc.exe delete $ServiceName | Out-Null
    Write-Host "Removed service '$ServiceName'." -ForegroundColor Green
    return
}

if (-not $ExePath) {
    $candidate = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\src\OGHost.Agent\bin\Release\net8.0\win-x64\publish\OGHost.Agent.exe"
    $ExePath = (Resolve-Path $candidate -ErrorAction SilentlyContinue).Path
}

if (-not $ExePath -or -not (Test-Path $ExePath)) {
    throw "Could not find OGHost.Agent.exe. Publish it first (dotnet publish -c Release -r win-x64 --self-contained) or pass -ExePath."
}

$ExePath = (Resolve-Path $ExePath).Path
$configPath = Join-Path (Split-Path -Parent $ExePath) "config.json"

if (-not (Test-Path $configPath)) {
    Write-Warning "config.json not found next to the executable. Run OGHost.Agent.exe once to create it, then add your pairing code."
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Service '$ServiceName' already exists; updating its binary path." -ForegroundColor Yellow
    if ($existing.Status -eq "Running") { Stop-Service -Name $ServiceName -Force }
    sc.exe config $ServiceName binPath= "`"$ExePath`"" | Out-Null
} else {
    New-Service -Name $ServiceName `
                -BinaryPathName "`"$ExePath`"" `
                -DisplayName $DisplayName `
                -Description $Description `
                -StartupType Automatic | Out-Null
    Write-Host "Created service '$ServiceName'." -ForegroundColor Green
}

# Restart automatically after a crash, and do not restart-loop too aggressively.
sc.exe failure $ServiceName reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null

Start-Service -Name $ServiceName
Write-Host ""
Write-Host "Service started." -ForegroundColor Green
Write-Host "  Executable : $ExePath"
Write-Host "  Config     : $configPath"
Write-Host ""
Write-Host "Watch the log with:  Get-Content -Wait (Join-Path (Split-Path '$ExePath') 'logs\agent.log')"
Write-Host "Stop with:           Stop-Service $ServiceName"
