# ==============================================================================
# COREGATE Automated One-Click Dedicated Server Installer for Dimraeth
# ==============================================================================
[CmdletBinding()]
param(
    [string]$CustomGameDir = "",
    [ValidateSet("Headless", "WebAdmin")]
    [string]$Edition = "",
    [switch]$WithGate,
    [switch]$NoGate
)

$ErrorActionPreference = "Stop"

Write-Host "========================================================================" -ForegroundColor DarkCyan
Write-Host "                COREGATE DEDICATED SERVER INSTALLER                     " -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor DarkCyan

# 1. Locate Dimraeth Installation
$TargetDir = $CustomGameDir
if (-not $TargetDir) {
    $candidates = [System.Collections.Generic.List[string]]::new()
    
    try {
        $steamPath = (Get-ItemProperty -Path "HKCU:\Software\Valve\Steam" -Name "SteamPath" -ErrorAction SilentlyContinue).SteamPath
        if ($steamPath) {
            $candidates.Add("$steamPath\steamapps\common\Dimraeth")
            $vdfPath = "$steamPath\steamapps\libraryfolders.vdf"
            if (Test-Path $vdfPath) {
                Get-Content $vdfPath | Where-Object { $_ -match '"path"\s+"([^"]+)"' } | ForEach-Object {
                    $p = $matches[1] -replace '\\\\', '\'
                    $candidates.Add("$p\steamapps\common\Dimraeth")
                }
            }
        }
    } catch {}

    $candidates.Add("C:\Program Files (x86)\Steam\steamapps\common\Dimraeth")
    $candidates.Add("D:\SteamLibrary\steamapps\common\Dimraeth")
    $candidates.Add("E:\SteamLibrary\steamapps\common\Dimraeth")

    foreach ($cand in $candidates) {
        if (Test-Path "$cand\Dimraeth.exe") {
            $TargetDir = $cand
            break
        }
    }
}

if (-not $TargetDir -or (-not (Test-Path "$TargetDir\Dimraeth.exe"))) {
    Write-Host "[!] Could not auto-detect Dimraeth directory." -ForegroundColor Yellow
    $prompt = Read-Host "Enter full path to Dimraeth folder (containing Dimraeth.exe)"
    $TargetDir = $prompt.Trim().Trim('"')
    if (-not (Test-Path "$TargetDir\Dimraeth.exe")) {
        Write-Host "[ERROR] Invalid game directory. Dimraeth.exe not found at '$TargetDir'. Aborting." -ForegroundColor Red
        exit 1
    }
}

Write-Host "[OK] Found Dimraeth at: $TargetDir" -ForegroundColor Green

# 2. Check BepInEx 6 IL2CPP
$bepinexDir = Join-Path $TargetDir "BepInEx"
$pluginsDir = Join-Path $bepinexDir "plugins"
$coreDir    = Join-Path $bepinexDir "core"
$cfgDir     = Join-Path $bepinexDir "config"

if (-not (Test-Path $coreDir)) {
    Write-Host "[!] Warning: BepInEx 6 IL2CPP not found in $bepinexDir." -ForegroundColor Yellow
    Write-Host "    Ensure BepInEx 6.0 (IL2CPP x64) is installed in the Dimraeth folder." -ForegroundColor Gray
}

if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null }
if (-not (Test-Path $cfgDir))     { New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null }

# Select Server Edition: Pure Headless CLI vs Headless + Web Admin Dashboard
if (-not $Edition) {
    Write-Host "`nChoose Server Edition:" -ForegroundColor Yellow
    Write-Host "  [1] Pure Headless CLI (Minimal, zero web ports, command-line only)" -ForegroundColor Cyan
    Write-Host "  [2] Headless + Web Admin Dashboard (Live map, player inspector, web console on :15574)" -ForegroundColor Cyan
    $choice = (Read-Host "Select edition [1/2, default: 2]").Trim()
    $Edition = if ($choice -eq "1") { "Headless" } else { "WebAdmin" }
}
Write-Host "[OK] Selected Edition: $Edition" -ForegroundColor Green

# 3. Create C:\Coregate control folder and metadata
$coregateRoot = "C:\Coregate"
if (-not (Test-Path $coregateRoot)) {
    New-Item -ItemType Directory -Path $coregateRoot -Force | Out-Null
}
try {
    & icacls.exe $coregateRoot /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
} catch { }

$metaJson = @{
    GameDir = $TargetDir
    Edition = $Edition
    InstalledAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
} | ConvertTo-Json
[System.IO.File]::WriteAllText("$coregateRoot\coregate.json", $metaJson, [System.Text.Encoding]::UTF8)

Write-Host "[*] Deploying Coregate components..." -ForegroundColor Cyan
$scriptDir = $PSScriptRoot

function Find-Source([string[]]$relPaths) {
    foreach ($rel in $relPaths) {
        $full = Join-Path $scriptDir $rel
        if (Test-Path $full) { return $full }
    }
    return $null
}

# Deploy Manager
$managerSrc = Find-Source @("scripts\CoregateManager.ps1", "src\Configurator\CoregateManager.ps1")
if ($managerSrc) {
    Copy-Item $managerSrc -Destination "$coregateRoot\CoregateManager.ps1" -Force
}

# Clean legacy mod filenames if upgrading
$legacyHost = Join-Path $pluginsDir "WaygateHost.dll"
$legacyAdmin = Join-Path $pluginsDir "WaygateAdmin.dll"
if (Test-Path $legacyHost) { Remove-Item $legacyHost -Force -ErrorAction SilentlyContinue }
if (Test-Path $legacyAdmin) { Remove-Item $legacyAdmin -Force -ErrorAction SilentlyContinue }

# Deploy Coregate Host Plugin
$hostDllSrc = Find-Source @("plugins\CoregateHost.dll")
if ($hostDllSrc) {
    Copy-Item $hostDllSrc -Destination (Join-Path $pluginsDir "CoregateHost.dll") -Force
    Write-Host "[OK] CoregateHost.dll deployed." -ForegroundColor Green
} else {
    Write-Host "[ERROR] plugins\CoregateHost.dll missing from package." -ForegroundColor Red
    exit 1
}

# Deploy Coregate Dedicated Server Helper Plugin
$gateSrc = Find-Source @("plugins\Coregate.dll", "src\Gate\bin\Release\net6.0\Coregate.dll")
if ($gateSrc) {
    Copy-Item $gateSrc -Destination (Join-Path $pluginsDir "Coregate.dll") -Force
    Write-Host "[OK] Coregate.dll deployed." -ForegroundColor Green
}

# Deploy WebAdmin Components if selected
if ($Edition -eq "WebAdmin") {
    $adminDllSrc = Find-Source @("plugins\CoregateAdmin.dll")
    if ($adminDllSrc) {
        Copy-Item $adminDllSrc -Destination (Join-Path $pluginsDir "CoregateAdmin.dll") -Force
        Write-Host "[OK] CoregateAdmin.dll deployed." -ForegroundColor Green
    }

    $adminWww = Join-Path $pluginsDir "CoregateAdmin\www"
    if (-not (Test-Path $adminWww)) {
        New-Item -ItemType Directory -Path $adminWww -Force | Out-Null
    }
    $webSource = Join-Path $scriptDir "web"
    if (Test-Path $webSource) {
        Copy-Item "$webSource\*" -Destination $adminWww -Recurse -Force
        Write-Host "[OK] Coregate Web Dashboard assets deployed to $adminWww" -ForegroundColor Green
    }
} else {
    # If headless, disable CoregateAdmin if present
    $adminLive = Join-Path $pluginsDir "CoregateAdmin.dll"
    if (Test-Path $adminLive) {
        Move-Item $adminLive -Destination "$adminLive.disabled" -Force -ErrorAction SilentlyContinue
    }
    Write-Host "[OK] Pure Headless CLI: Zero web ports opened." -ForegroundColor Gray
}

# Pre-seed Coregate Host & Admin configs
$hostCfgFile = Join-Path $cfgDir "com.coregate.host.cfg"
if (-not (Test-Path $hostCfgFile)) {
    @"
[Host]
Enable = true
GamePort = 15569
ListenAddress = 0.0.0.0
MaxPlayers = 8
ServerName = Dimraeth Coregate Server
HostCharacter = false
HideHostCharacter = true
QueryEnable = false
QueryNoChallenge = false
FrameCap = 30
IdleFrameCap = 8
"@ | Set-Content -Path $hostCfgFile -Encoding UTF8
}

if ($Edition -eq "WebAdmin") {
    $adminCfgFile = Join-Path $cfgDir "com.coregate.admin.cfg"
    if (-not (Test-Path $adminCfgFile)) {
        $adminWwwPath = Join-Path $pluginsDir "CoregateAdmin\www"
        @"
[Admin]
Enable = true
BindAddress = 0.0.0.0
Password = P@ssw0rd
HttpPort = 0
RconPort = 0
PublicPlayerList = true

[Web]
Enable = true
Port = 0
PublicMap = true
WebRoot = $adminWwwPath
"@ | Set-Content -Path $adminCfgFile -Encoding UTF8
    }
}

# Handle Fresh Character gate policy (Level 1 Lock)
$gateCfgPath = Join-Path $cfgDir "com.coregate.gate.cfg"
$enableFreshOnly = $false
if ($WithGate) {
    $enableFreshOnly = $true
} elseif ($NoGate) {
    $enableFreshOnly = $false
} else {
    Write-Host "`nCharacter Admission Policy:" -ForegroundColor Yellow
    Write-Host "   [1] Open Admission (Allow existing characters from any level)" -ForegroundColor DarkGray
    Write-Host "   [2] Fresh Characters Only (Enforce Level 1 starting characters)" -ForegroundColor DarkGray
    $gateChoice = (Read-Host "Choose admission policy [1/2, default: 1]").Trim()
    if ($gateChoice -eq "2") { $enableFreshOnly = $true }
}

if (-not (Test-Path $gateCfgPath)) {
    @"
[Gate]
FreshCharactersOnly = $($enableFreshOnly.ToString().ToLower())
MaxFirstJoinLevel = 1
RejectMessage = This dedicated server requires a fresh character (Level 1). Please create a new character to join.

[Gameplay]
EnablePersonalRest = true
RestCooldownSeconds = 600
AutoSaveIntervalMinutes = 15

[Server]
ServerNote = Dedicated Server powered by Coregate
"@ | Set-Content -Path $gateCfgPath -Encoding UTF8
}

# Create start.bat
$startBatContent = "@echo off`r`ncd /d ""$TargetDir""`r`nstart """" ""Dimraeth.exe"" -batchmode -nographics -logFile ""$coregateRoot\server.log""`r`n"
[System.IO.File]::WriteAllText("$coregateRoot\start.bat", $startBatContent, [System.Text.Encoding]::ASCII)

# Create launcher batch files
$cmdBat = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File ""$coregateRoot\CoregateManager.ps1""`r`n"
[System.IO.File]::WriteAllText("$coregateRoot\CoregateSetup_CMD.bat", $cmdBat, [System.Text.Encoding]::ASCII)

$guiBat = "@echo off`r`nstart powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$coregateRoot\CoregateManager.ps1"" -Gui`r`n"
[System.IO.File]::WriteAllText("$coregateRoot\CoregateSetup_GUI.bat", $guiBat, [System.Text.Encoding]::ASCII)

# Register CoregateServer scheduled task
try {
    $action = New-ScheduledTaskAction -Execute "$env:ComSpec" -Argument "/c ""$coregateRoot\start.bat""" -WorkingDirectory $TargetDir
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
    Register-ScheduledTask -TaskName "CoregateServer" -Action $action -Principal $principal -Description "COREGATE headless Dimraeth server" -Force | Out-Null
    Write-Host "[OK] Registered scheduled task 'CoregateServer'" -ForegroundColor Green
} catch {
    Write-Host "[!] Could not register scheduled task 'CoregateServer': $($_.Exception.Message)" -ForegroundColor Yellow
}

# Create Desktop Shortcuts
$desktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$psExe = (Get-Process -Id $PID).Path
if (-not $psExe -or (-not (Test-Path $psExe))) { $psExe = "powershell.exe" }

$wsh = New-Object -ComObject WScript.Shell

$lnkCmd = $wsh.CreateShortcut("$desktopPath\COREGATE Setup (CMD).lnk")
$lnkCmd.TargetPath = $psExe
$lnkCmd.Arguments = "-NoProfile -ExecutionPolicy Bypass -File ""$coregateRoot\CoregateManager.ps1"""
$lnkCmd.WorkingDirectory = $coregateRoot
$lnkCmd.Description = "COREGATE Terminal & CMD Configurator"
$lnkCmd.Save()

$lnkGui = $wsh.CreateShortcut("$desktopPath\COREGATE Control (GUI).lnk")
$lnkGui.TargetPath = $psExe
$lnkGui.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$coregateRoot\CoregateManager.ps1"" -Gui"
$lnkGui.WorkingDirectory = $coregateRoot
$lnkGui.Description = "COREGATE Visual Windows Setup Program"
$lnkGui.Save()

Write-Host "[OK] Created desktop shortcuts: 'COREGATE Setup (CMD)' & 'COREGATE Control (GUI)'" -ForegroundColor Green

Write-Host "`n[*] Starting First-Run Configuration Wizard..." -ForegroundColor Yellow
Start-Sleep -Seconds 1
& $psExe -NoProfile -ExecutionPolicy Bypass -File "$coregateRoot\CoregateManager.ps1"
