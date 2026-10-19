# ==============================================================================
# COREGATE Dedicated Server Manager & First-Run Setup Engine
# Native Steam Matchmaking P2P Lobby + Realtime Web Map for Dimraeth
# ==============================================================================
param(
    [switch]$Gui,
    [switch]$Setup,
    [switch]$Start,
    [switch]$Stop,
    [switch]$Restart,
    [switch]$Status
)

$CoregateRoot = "C:\Coregate"
if (-not (Test-Path $CoregateRoot)) {
    New-Item -ItemType Directory -Path $CoregateRoot -Force | Out-Null
}

# Resolve Dimraeth Game Directory
$GameDir = ""
$meta = $null
$configJson = Join-Path $CoregateRoot "coregate.json"
if (Test-Path $configJson) {
    try {
        $meta = Get-Content $configJson -Raw | ConvertFrom-Json
        if ($meta.GameDir -and (Test-Path "$($meta.GameDir)\Dimraeth.exe")) {
            $GameDir = $meta.GameDir
        }
    } catch {}
}

if (-not $GameDir) {
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
            $GameDir = $cand
            break
        }
    }
}

if (-not $GameDir) {
    $GameDir = "C:\Program Files (x86)\Steam\steamapps\common\Dimraeth"
}

$BepInExDir = Join-Path $GameDir "BepInEx"
$PluginsDir = Join-Path $BepInExDir "plugins"
$ConfigDir  = Join-Path $BepInExDir "config"

# Resolve Server Edition
$ServerEdition = if ($meta -and $meta.Edition) { 
    $meta.Edition 
} elseif (Test-Path (Join-Path $PluginsDir "CoregateAdmin.dll")) { 
    "WebAdmin" 
} else { 
    "Headless" 
}

$HostCfg  = Join-Path $ConfigDir "com.coregate.host.cfg"
$AdminCfg = Join-Path $ConfigDir "com.coregate.admin.cfg"
$GateCfg  = Join-Path $ConfigDir "com.coregate.gate.cfg"
$ExePath  = Join-Path $GameDir "Dimraeth.exe"
$StartBat = Join-Path $CoregateRoot "start.bat"

# BepInEx cfg files repeat key names across sections (JoinPassword lives in both [Client]
# and [Host]), so every read and write is scoped to one section.
function Get-CfgValue($filePath, $section, $key) {
    if (-not (Test-Path $filePath)) { return "" }
    $lines = Get-Content $filePath -Encoding UTF8 -ErrorAction SilentlyContinue
    $inSection = $false
    foreach ($line in $lines) {
        if ($line -match '^\s*\[(.+)\]\s*$') { $inSection = ($matches[1] -eq $section); continue }
        if ($inSection -and $line -match "^\s*$([regex]::Escape($key))\s*=\s*(.*)$") {
            return $matches[1].Trim()
        }
    }
    return ""
}

function Set-CfgValue($filePath, $section, $key, $val) {
    $dir = Split-Path $filePath -Parent
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path $filePath) {
        $existing = Get-Content $filePath -Encoding UTF8 -ErrorAction SilentlyContinue
        if ($existing) {
            foreach ($el in $existing) { $lines.Add($el) }
        }
    }

    $inSection = $false
    $sectionEnd = -1
    $done = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*\[(.+)\]\s*$') {
            if ($inSection) { break }
            $inSection = ($matches[1] -eq $section)
            if ($inSection) { $sectionEnd = $i }
            continue
        }
        if (-not $inSection) { continue }
        if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") {
            $lines[$i] = "$key = $val"
            $done = $true
            break
        }
        if ($lines[$i].Trim()) { $sectionEnd = $i }
    }

    if (-not $done) {
        if ($sectionEnd -ge 0) {
            $lines.Insert($sectionEnd + 1, "$key = $val")
        } else {
            if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim()) { $lines.Add("") }
            $lines.Add("[$section]")
            $lines.Add("$key = $val")
        }
    }

    [System.IO.File]::WriteAllLines($filePath, $lines, [System.Text.UTF8Encoding]::new($false))
}

# The admin plugin serves the dashboard on [Web] Port; 0 or empty means its default, 15574.
function Get-WebPort {
    $p = 0
    if ([int]::TryParse((Get-CfgValue $AdminCfg "Web" "Port"), [ref]$p) -and $p -gt 0) { return $p }
    return 15574
}

# Signed admin API call, same scheme as web/app.js: key = SHA256(password),
# signature = HMAC-SHA256(key, "METHOD\npath\ntimestamp\nhex(SHA256(body))").
function Invoke-AdminApi($method, $path, $bodyObj) {
    $adminPass = Get-CfgValue $AdminCfg "Admin" "Password"
    if (-not $adminPass) { return $null }
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $body = if ($bodyObj) { $bodyObj | ConvertTo-Json -Compress } else { "" }
    $bodyBytes = $utf8.GetBytes($body)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $toHex = { param($b) -join ($b | ForEach-Object { $_.ToString("x2") }) }
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($sha.ComputeHash($utf8.GetBytes($adminPass)))
    $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $canonical = "$method`n$path`n$ts`n$(& $toHex $sha.ComputeHash($bodyBytes))"
    $sig = & $toHex $hmac.ComputeHash($utf8.GetBytes($canonical))
    $headers = @{ "X-Waygate-Timestamp" = "$ts"; "X-Waygate-Signature" = $sig }
    $uri = "http://127.0.0.1:$(Get-WebPort)$path"
    if ($method -eq "GET") {
        return Invoke-RestMethod -Uri $uri -Method Get -Headers $headers -TimeoutSec 10 -ErrorAction Stop
    }
    return Invoke-RestMethod -Uri $uri -Method $method -Headers $headers -Body $bodyBytes -ContentType "application/json" -TimeoutSec 20 -ErrorAction Stop
}

function Get-ServerState {
    $proc = Get-Process -Name "Dimraeth" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) {
        $ram = [math]::Round($proc.WorkingSet64 / 1MB, 0)
        return @{ Online = $true; Pid = $proc.Id; Ram = $ram }
    }
    return @{ Online = $false; Pid = 0; Ram = 0 }
}

function Start-Coregate {
    $state = Get-ServerState
    if ($state.Online) {
        Write-Host "Server is already active (PID $($state.Pid), $($state.Ram) MB RAM)." -ForegroundColor Yellow
        return
    }
    Write-Host "Starting COREGATE server..." -ForegroundColor Cyan

    # Clean up any leftover save trigger/done files from previous sessions
    $saveTrigger = Join-Path $ConfigDir "save.trigger"
    $saveDoneFile = Join-Path $ConfigDir "save.done"
    if (Test-Path $saveTrigger) { Remove-Item $saveTrigger -Force -ErrorAction SilentlyContinue }
    if (Test-Path $saveDoneFile) { Remove-Item $saveDoneFile -Force -ErrorAction SilentlyContinue }

    # Prefer the interactive scheduled task (registered by install.ps1) so the game reaches
    # the logged-in user's Steam client even when this script runs over headless SSH.
    $task = Get-ScheduledTask -TaskName "CoregateServer" -ErrorAction SilentlyContinue
    if ($task) {
        Start-ScheduledTask -TaskName "CoregateServer" -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        $newState = Get-ServerState
        if ($newState.Online) {
            Write-Host "[OK] COREGATE is online! (PID: $($newState.Pid), RAM: $($newState.Ram) MB)" -ForegroundColor Green
            return
        }
    }

    if (-not (Test-Path $StartBat)) {
        $content = "@echo off`r`ncd /d ""$GameDir""`r`nstart """" ""Dimraeth.exe"" -batchmode -nographics -logFile ""$CoregateRoot\server.log""`r`n"
        [System.IO.File]::WriteAllText($StartBat, $content, [System.Text.Encoding]::ASCII)
    }

    Start-Process -FilePath "$env:ComSpec" -ArgumentList "/c `"$StartBat`"" -WorkingDirectory $GameDir -WindowStyle Minimized
    Start-Sleep -Seconds 2

    $newState = Get-ServerState
    if ($newState.Online) {
        Write-Host "[OK] COREGATE is online! (PID: $($newState.Pid), RAM: $($newState.Ram) MB)" -ForegroundColor Green
    } else {
        Write-Host "[OK] Launch triggered. Initializing world scenes..." -ForegroundColor Green
    }
}

function Stop-Coregate {
    param([string]$Reason = "Scheduled maintenance / restart", [switch]$Immediate)
    Write-Host "Shutting down COREGATE server..." -ForegroundColor Yellow
    $state = Get-ServerState
    if (-not $state.Online) {
        Write-Host "Server is not currently running." -ForegroundColor DarkGray
        return
    }

    if (-not $Immediate -and $ServerEdition -eq "WebAdmin") {
        Write-Host "Broadcasting 20-second countdown to in-game Announcements..." -ForegroundColor Cyan
        $steps = @(
            @{ Sec = 20; Wait = 5 },
            @{ Sec = 15; Wait = 5 },
            @{ Sec = 10; Wait = 5 },
            @{ Sec = 5;  Wait = 1 },
            @{ Sec = 4;  Wait = 1 },
            @{ Sec = 3;  Wait = 1 },
            @{ Sec = 2;  Wait = 1 },
            @{ Sec = 1;  Wait = 1 }
        )
        foreach ($s in $steps) {
            $msg = "[SERVER SHUTDOWN] Server stopping in $($s.Sec)s ($Reason). Saving all character & world progress..."
            Write-Host "   [Announcement] $msg" -ForegroundColor Yellow
            try {
                $null = Invoke-AdminApi "POST" "/api/v1/chat/announce" ([ordered]@{ msg = $msg; by = "manager" })
            } catch { }
            Start-Sleep -Seconds $s.Wait
        }
        try {
            $null = Invoke-AdminApi "POST" "/api/v1/chat/announce" ([ordered]@{ msg = "[SERVER SHUTDOWN] Saving world and stopping server now. See you shortly!"; by = "manager" })
        } catch { }
    }

    # Save the world before the process is killed
    $saveDone = $false
    if ($ServerEdition -eq "WebAdmin") {
        try {
            $res = Invoke-AdminApi "POST" "/api/v1/save" ([ordered]@{ by = "manager" })
            if ($res) {
                Write-Host "[OK] World save completed via Admin API." -ForegroundColor Green
                $saveDone = $true
                Start-Sleep -Seconds 1
            }
        } catch { }
    }

    # In Headless CLI or as fallback, signal Coregate save trigger with two-way handshake
    if (-not $saveDone) {
        $saveTrigger = Join-Path $ConfigDir "save.trigger"
        $saveDoneFile = Join-Path $ConfigDir "save.done"
        if (Test-Path $saveDoneFile) { Remove-Item $saveDoneFile -Force -ErrorAction SilentlyContinue }

        try {
            [System.IO.File]::WriteAllText($saveTrigger, "save", [System.Text.Encoding]::ASCII)
            Write-Host "[*] Signaling world save to server..." -ForegroundColor Cyan
            $waited = 0
            while ($waited -lt 15) {
                Start-Sleep -Seconds 1
                $waited++
                if (Test-Path $saveDoneFile) {
                    $saveDone = $true
                    Remove-Item $saveDoneFile -Force -ErrorAction SilentlyContinue
                    break
                }
            }
            if ($saveDone) {
                Write-Host "[OK] World save confirmed by server." -ForegroundColor Green
            } else {
                Write-Host "[!] Save confirmation timed out, proceeding to halt." -ForegroundColor Yellow
            }
        } catch {
            Write-Host "[!] Could not signal save trigger: $($_.Exception.Message)" -ForegroundColor Yellow
        } finally {
            if (Test-Path $saveTrigger) { Remove-Item $saveTrigger -Force -ErrorAction SilentlyContinue }
            if (Test-Path $saveDoneFile) { Remove-Item $saveDoneFile -Force -ErrorAction SilentlyContinue }
        }
    }

    Stop-Process -Id $state.Pid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Write-Host "[OK] Server halted." -ForegroundColor Green
}

# --- VALIDATION HELPERS WITH STRICT PRODUCT LIMITS ---
function Validate-ServerName($name) {
    if ([string]::IsNullOrWhiteSpace($name)) { return "Server name cannot be empty." }
    $trimmed = $name.Trim()
    if ($trimmed.Length -lt 3) { return "Server name must be at least 3 characters." }
    $byteCount = [System.Text.Encoding]::UTF8.GetByteCount($trimmed)
    if ($byteCount -gt 63) { return "Server name exceeds Steam 63-byte limit ($byteCount bytes)." }
    return $null
}

function Validate-WorldName($world) {
    if ([string]::IsNullOrWhiteSpace($world)) { return "World name cannot be empty." }
    $trimmed = $world.Trim()
    if ($trimmed.Length -lt 2) { return "World name must be at least 2 characters." }
    if ($trimmed.Length -gt 32) { return "World name exceeds 32 character limit." }
    if ($trimmed -notmatch "^[a-zA-Z0-9_\-]+$") { return "World name can only contain letters, numbers, hyphens, and underscores." }
    return $null
}

function Validate-PlayerCap($cap) {
    $val = 0
    if (-not [int]::TryParse($cap, [ref]$val)) { return "Player count must be a valid number." }
    if ($val -lt 1) { return "Player count must be at least 1." }
    if ($val -gt 32) { return "Player count maximum supported is 32." }
    return $null
}

function Validate-AdminPassword($pass) {
    if ([string]::IsNullOrWhiteSpace($pass)) { return "Admin password cannot be blank." }
    $trimmed = $pass.Trim()
    if ($trimmed.Length -lt 4) { return "Admin password must be at least 4 characters." }
    if ($trimmed.Length -gt 64) { return "Admin password exceeds 64 characters." }
    return $null
}

function Validate-JoinPassword($pass) {
    if ([string]::IsNullOrEmpty($pass)) { return $null }
    $trimmed = $pass.Trim()
    if ($trimmed.Length -gt 32) { return "Join password exceeds 32 characters." }
    return $null
}

# --- FIRST-RUN ONBOARDING WIZARD ---
function Run-FirstRunWizard {
    Clear-Host
    Write-Host "========================================================================" -ForegroundColor DarkCyan
    Write-Host "                  COREGATE FIRST-RUN SETUP WIZARD                      " -ForegroundColor Cyan
    Write-Host "========================================================================" -ForegroundColor DarkCyan
    Write-Host "Configure your dedicated server in a few quick steps.`n" -ForegroundColor Gray

    # 1. Server Display Name
    $currSrv = Get-CfgValue $HostCfg "Host" "ServerName"
    if (-not $currSrv) { $currSrv = "Coregate | Realm of Dimraeth" }
    $srvName = ""
    while ($true) {
        Write-Host "1. SERVER DISPLAY NAME (Shown in in-game Steam browser, 3-63 bytes)" -ForegroundColor Yellow
        Write-Host "   Default: $currSrv" -ForegroundColor DarkGray
        $userInput = Read-Host "   Enter Name (Press Enter to keep default)"
        $candidate = if ($userInput) { $userInput.Trim() } else { $currSrv }
        $err = Validate-ServerName $candidate
        if (-not $err) {
            $srvName = $candidate
            break
        }
        Write-Host "   [!] $err" -ForegroundColor Red
    }

    # 2. Server Lobby Note
    $currNote = Get-CfgValue $GateCfg "Server" "ServerNote"
    if (-not $currNote) { $currNote = "Dedicated Server powered by Coregate" }
    Write-Host "`n2. SERVER LOBBY NOTE (Description shown in Steam server browser)" -ForegroundColor Yellow
    Write-Host "   Default: $currNote" -ForegroundColor DarkGray
    $userInput = Read-Host "   Enter Server Note (Press Enter to keep default)"
    $srvNote = if ($userInput) { $userInput.Trim() } else { $currNote }

    # 3. World Save Name
    $currWorld = Get-CfgValue $HostCfg "World" "Name"
    if (-not $currWorld) { $currWorld = "Coregate" }
    $worldName = ""
    while ($true) {
        Write-Host "`n3. WORLD SAVE NAME (Alphanumeric/dashes/underscores, 2-32 chars)" -ForegroundColor Yellow
        Write-Host "   Default: $currWorld" -ForegroundColor DarkGray
        $userInput = Read-Host "   Enter World Name (Press Enter to keep default)"
        $candidate = if ($userInput) { $userInput.Trim() } else { $currWorld }
        $err = Validate-WorldName $candidate
        if (-not $err) {
            $worldName = $candidate
            break
        }
        Write-Host "   [!] $err" -ForegroundColor Red
    }

    # 4. Character Admission Policy (Fresh Level 1 vs Open)
    $currFresh = (Get-CfgValue $GateCfg "Gate" "FreshCharactersOnly").ToLower() -eq "true"
    Write-Host "`n4. CHARACTER ADMISSION (Level 1 Lock)" -ForegroundColor Yellow
    Write-Host "   [1] Open Admission (Allow existing characters from any level - Default)" -ForegroundColor DarkGray
    Write-Host "   [2] Fresh Characters Only (Enforce Level 1 starting characters)" -ForegroundColor DarkGray
    $gateChoice = Read-Host "   Select (1-2, Enter for default)"
    $freshOnly = if ($gateChoice -eq "2") { "true" } elseif ($gateChoice -eq "1") { "false" } else { if ($currFresh) { "true" } else { "false" } }

    # 5. Friendly Fire (PvP)
    $currFF = (Get-CfgValue $HostCfg "World" "FriendlyFire").ToLower() -eq "true"
    Write-Host "`n5. FRIENDLY FIRE (PvP)" -ForegroundColor Yellow
    Write-Host "   [1] Disabled (Co-op PvE - Default)  [2] Enabled (Full PvP)" -ForegroundColor DarkGray
    $ffChoice = Read-Host "   Select (1-2, Enter for default)"
    $friendlyFire = if ($ffChoice -eq "2") { "true" } elseif ($ffChoice -eq "1") { "false" } else { if ($currFF) { "true" } else { "false" } }

    # 6. Player Capacity
    $currPlayers = Get-CfgValue $HostCfg "Host" "MaxPlayers"
    if (-not $currPlayers) { $currPlayers = "10" }
    $playerCap = ""
    while ($true) {
        Write-Host "`n6. MAXIMUM PLAYERS (1-32 seats)" -ForegroundColor Yellow
        Write-Host "   Default: $currPlayers" -ForegroundColor DarkGray
        $userInput = Read-Host "   Enter Player Limit (Press Enter to keep default)"
        $candidate = if ($userInput) { $userInput.Trim() } else { $currPlayers }
        $err = Validate-PlayerCap $candidate
        if (-not $err) {
            $playerCap = $candidate
            break
        }
        Write-Host "   [!] $err" -ForegroundColor Red
    }

    # 7. Join Password (Optional)
    $currPass = Get-CfgValue $HostCfg "Host" "JoinPassword"
    $joinPass = ""
    while ($true) {
        Write-Host "`n7. JOIN PASSWORD (Optional for public server, max 32 chars)" -ForegroundColor Yellow
        if ($currPass) { Write-Host "   A join password is set. Enter to keep, '-' to remove." -ForegroundColor DarkGray }
        else { Write-Host "   Leave empty for an open public server." -ForegroundColor DarkGray }
        $userInput = Read-Host "   Enter Join Password"
        if ($userInput -eq "-") { $joinPass = ""; break }
        $candidate = if ($userInput) { $userInput.Trim() } else { $currPass }
        $err = Validate-JoinPassword $candidate
        if (-not $err) {
            $joinPass = $candidate
            break
        }
        Write-Host "   [!] $err" -ForegroundColor Red
    }

    # 8. Admin / Web Console Password (Only required in WebAdmin edition)
    $currAdmin = Get-CfgValue $AdminCfg "Admin" "Password"
    $adminPass = $currAdmin
    if ($ServerEdition -eq "WebAdmin") {
        while ($true) {
            Write-Host "`n8. ADMIN & WEB DASHBOARD PASSWORD (Required for live console, 4-64 chars)" -ForegroundColor Yellow
            if ($currAdmin) { Write-Host "   A password is already set. Press Enter to keep it." -ForegroundColor DarkGray }
            $userInput = Read-Host "   Enter Admin Password"
            $candidate = if ($userInput) { $userInput.Trim() } else { $currAdmin }
            $err = Validate-AdminPassword $candidate
            if (-not $err) {
                $adminPass = $candidate
                break
            }
            Write-Host "   [!] $err" -ForegroundColor Red
        }
    } else {
        if (-not $adminPass) {
            $adminPass = [System.Guid]::NewGuid().ToString("N")
        }
    }

    # 9. Difficulty
    $currDiff = Get-CfgValue $HostCfg "World" "Difficulty"
    if (-not $currDiff) { $currDiff = "Moderate" }
    Write-Host "`n9. DIFFICULTY [1] Moderate  [2] Easy  [3] Hard" -ForegroundColor Yellow
    Write-Host "   Current: $currDiff" -ForegroundColor DarkGray
    $dChoice = Read-Host "   Select (1-3, Enter for current)"
    $difficulty = switch ($dChoice) {
        "1" { "Moderate" }
        "2" { "Easy" }
        "3" { "Hard" }
        default { $currDiff }
    }

    # Apply configuration
    Write-Host "`nSaving configuration to disk..." -ForegroundColor Cyan
    Set-CfgValue $HostCfg "Host" "ServerName" $srvName
    Set-CfgValue $HostCfg "Client" "ServerListName" $srvName
    Set-CfgValue $GateCfg "Server" "ServerNote" $srvNote
    Set-CfgValue $HostCfg "World" "Name" $worldName
    Set-CfgValue $GateCfg "Gate" "FreshCharactersOnly" $freshOnly
    Set-CfgValue $HostCfg "World" "FriendlyFire" $friendlyFire
    Set-CfgValue $HostCfg "Host" "MaxPlayers" $playerCap
    Set-CfgValue $HostCfg "Host" "JoinPassword" $joinPass
    Set-CfgValue $HostCfg "World" "Difficulty" $difficulty
    Set-CfgValue $AdminCfg "Admin" "Password" $adminPass

    # Verify write
    $readSrv = Get-CfgValue $HostCfg "Host" "ServerName"
    if ($readSrv -eq $srvName) {
        $flagPath = Join-Path $CoregateRoot ".configured"
        [System.IO.File]::WriteAllText($flagPath, (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), [System.Text.Encoding]::UTF8)
        Write-Host "[OK] Configuration verified and saved!" -ForegroundColor Green
    } else {
        Write-Host "[!] Warning: Configuration written to disk but verification mismatch." -ForegroundColor Yellow
    }
    Start-Sleep -Seconds 2
}

function Show-GuiWindow {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "COREGATE - Dimraeth Dedicated Server Setup"
    $guiHeight = if ($ServerEdition -eq "WebAdmin") { 810 } else { 760 }
    $form.Size = New-Object System.Drawing.Size(700, $guiHeight)
    $form.StartPosition = "CenterScreen"
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false
    $form.BackColor = [System.Drawing.Color]::FromArgb(11, 15, 23)
    $form.ForeColor = [System.Drawing.Color]::FromArgb(241, 245, 249)

    $titleFont = New-Object System.Drawing.Font("Segoe UI", 16, [System.Drawing.FontStyle]::Bold)
    $subFont   = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Regular)
    $secFont   = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
    $lblFont   = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
    $inFont    = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Regular)
    $btnFont   = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
    $tipFont   = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Regular)

    # Header
    $lblHeader = New-Object System.Windows.Forms.Label
    $lblHeader.Text = "COREGATE DEDICATED SERVER"
    $lblHeader.Font = $titleFont
    $lblHeader.ForeColor = [System.Drawing.Color]::FromArgb(6, 182, 212)
    $lblHeader.Location = New-Object System.Drawing.Point(20, 14)
    $lblHeader.Size = New-Object System.Drawing.Size(640, 30)
    $form.Controls.Add($lblHeader)

    $lblSub = New-Object System.Windows.Forms.Label
    $lblSub.Text = if ($ServerEdition -eq "WebAdmin") { "Native Steam Matchmaking + Web Live Dashboard (:15574)" } else { "Pure Headless CLI Runtime + Native Steam Matchmaking (Zero Web Ports)" }
    $lblSub.Font = $subFont
    $lblSub.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
    $lblSub.Location = New-Object System.Drawing.Point(22, 44)
    $lblSub.Size = New-Object System.Drawing.Size(640, 20)
    $form.Controls.Add($lblSub)

    # Status Panel
    $pnlStatus = New-Object System.Windows.Forms.Panel
    $pnlStatus.Location = New-Object System.Drawing.Point(20, 70)
    $pnlStatus.Size = New-Object System.Drawing.Size(640, 40)
    $pnlStatus.BackColor = [System.Drawing.Color]::FromArgb(19, 25, 38)
    $form.Controls.Add($pnlStatus)

    $lblStatusText = New-Object System.Windows.Forms.Label
    $lblStatusText.Font = $lblFont
    $lblStatusText.Location = New-Object System.Drawing.Point(14, 10)
    $lblStatusText.Size = New-Object System.Drawing.Size(610, 20)
    $pnlStatus.Controls.Add($lblStatusText)

    function Refresh-GuiStatus {
        $st = Get-ServerState
        if ($st.Online) {
            $lblStatusText.Text = "STATUS: ONLINE (PID $($st.Pid) | Memory: $($st.Ram) MB)"
            $lblStatusText.ForeColor = [System.Drawing.Color]::FromArgb(16, 185, 129)
        } else {
            $lblStatusText.Text = "STATUS: OFFLINE (Server Halted)"
            $lblStatusText.ForeColor = [System.Drawing.Color]::FromArgb(239, 68, 68)
        }
    }
    Refresh-GuiStatus

    # Helper function for stacked input
    function Add-StackedInput($label, $initVal, $xPos, $yPos, $width = 305, $isPass = $false, $maxLen = 64) {
        $lbl = New-Object System.Windows.Forms.Label
        $lbl.Text = $label
        $lbl.Font = $lblFont
        $lbl.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
        $lbl.Location = New-Object System.Drawing.Point($xPos, $yPos)
        $lbl.Size = New-Object System.Drawing.Size($width, 18)
        $form.Controls.Add($lbl)

        $txt = New-Object System.Windows.Forms.TextBox
        $txt.Font = $inFont
        $txt.Text = $initVal
        $txt.MaxLength = $maxLen
        $txt.Location = New-Object System.Drawing.Point($xPos, ($yPos + 20))
        $txt.Size = New-Object System.Drawing.Size($width, 24)
        $txt.BackColor = [System.Drawing.Color]::FromArgb(25, 33, 49)
        $txt.ForeColor = [System.Drawing.Color]::White
        $txt.BorderStyle = "FixedSingle"
        if ($isPass) { $txt.UseSystemPasswordChar = $true }
        $form.Controls.Add($txt)
        return $txt
    }

    # Left Column: SERVER & NETWORK (x = 20, width = 305)
    $lblCol1 = New-Object System.Windows.Forms.Label
    $lblCol1.Text = "SERVER & NETWORK"
    $lblCol1.Font = $secFont
    $lblCol1.ForeColor = [System.Drawing.Color]::FromArgb(56, 189, 248)
    $lblCol1.Location = New-Object System.Drawing.Point(20, 120)
    $lblCol1.Size = New-Object System.Drawing.Size(305, 22)
    $form.Controls.Add($lblCol1)

    $yLeft = 145
    $txtServerName = Add-StackedInput "Server Display Name (3-63):" (Get-CfgValue $HostCfg "Host" "ServerName") 20 $yLeft 305 $false 63
    $yLeft += 50

    $txtNote = Add-StackedInput "Server Lobby Note (Steam browser):" (Get-CfgValue $GateCfg "Server" "ServerNote") 20 $yLeft 305 $false 64
    $yLeft += 50

    $txtMotd = $null
    if ($ServerEdition -eq "WebAdmin") {
        $txtMotd = Add-StackedInput "Chat MOTD (Welcome Message):" (Get-CfgValue $AdminCfg "Chat" "Motd") 20 $yLeft 305 $false 128
        $yLeft += 50
    }

    $txtWorld = Add-StackedInput "World Save Name (2-32):" (Get-CfgValue $HostCfg "World" "Name") 20 $yLeft 305 $false 32
    $yLeft += 50

    $txtPlayers = Add-StackedInput "Player Limit (1-32 seats):" (Get-CfgValue $HostCfg "Host" "MaxPlayers") 20 $yLeft 305 $false 2
    $yLeft += 50

    # Difficulty Dropdown
    $lblDiff = New-Object System.Windows.Forms.Label
    $lblDiff.Text = "World Difficulty:"
    $lblDiff.Font = $lblFont
    $lblDiff.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
    $lblDiff.Location = New-Object System.Drawing.Point(20, $yLeft)
    $lblDiff.Size = New-Object System.Drawing.Size(305, 18)
    $form.Controls.Add($lblDiff)

    $cmbDiff = New-Object System.Windows.Forms.ComboBox
    $cmbDiff.Font = $inFont
    $cmbDiff.DropDownStyle = "DropDownList"
    $cmbDiff.Items.AddRange(@("Moderate", "Easy", "Hard"))
    $currentDiff = Get-CfgValue $HostCfg "World" "Difficulty"
    $matchIdx = 0
    if ($currentDiff) {
        for ($i = 0; $i -lt $cmbDiff.Items.Count; $i++) {
            if ($cmbDiff.Items[$i].ToString().ToLower() -eq $currentDiff.ToLower()) {
                $matchIdx = $i; break
            }
        }
    }
    $cmbDiff.SelectedIndex = $matchIdx
    $cmbDiff.Location = New-Object System.Drawing.Point(20, ($yLeft + 20))
    $cmbDiff.Size = New-Object System.Drawing.Size(305, 24)
    $cmbDiff.BackColor = [System.Drawing.Color]::FromArgb(25, 33, 49)
    $cmbDiff.ForeColor = [System.Drawing.Color]::White
    $form.Controls.Add($cmbDiff)
    $yLeft += 50

    $txtJoinPass = Add-StackedInput "Join Password (Optional):" (Get-CfgValue $HostCfg "Host" "JoinPassword") 20 $yLeft 305 $false 32
    $yLeft += 50

    $txtAdminPass = $null
    if ($ServerEdition -eq "WebAdmin") {
        $txtAdminPass = Add-StackedInput "Admin Password (4-64):" (Get-CfgValue $AdminCfg "Admin" "Password") 20 $yLeft 305 $true 64
        $yLeft += 50
    }

    # Right Column: RULES & GAMEPLAY (x = 355, width = 305)
    $lblCol2 = New-Object System.Windows.Forms.Label
    $lblCol2.Text = "RULES & GAMEPLAY"
    $lblCol2.Font = $secFont
    $lblCol2.ForeColor = [System.Drawing.Color]::FromArgb(56, 189, 248)
    $lblCol2.Location = New-Object System.Drawing.Point(355, 120)
    $lblCol2.Size = New-Object System.Drawing.Size(305, 22)
    $form.Controls.Add($lblCol2)

    function Add-Checkbox($text, $isChecked, $xPos, $yPos, $width = 305) {
        $chk = New-Object System.Windows.Forms.CheckBox
        $chk.Text = $text
        $chk.Font = $lblFont
        $chk.ForeColor = [System.Drawing.Color]::FromArgb(241, 245, 249)
        $chk.BackColor = [System.Drawing.Color]::FromArgb(11, 15, 23)
        $chk.Location = New-Object System.Drawing.Point($xPos, $yPos)
        $chk.Size = New-Object System.Drawing.Size($width, 28)
        $chk.Checked = $isChecked
        $form.Controls.Add($chk)
        return $chk
    }

    $yRight = 145
    $chkFriendlyFire = Add-Checkbox "Friendly Fire (Enable PvP combat)" ((Get-CfgValue $HostCfg "World" "FriendlyFire").ToLower() -eq "true") 355 $yRight
    $yRight += 34

    $chkPersonalLoot = Add-Checkbox "Personal Loot Drops (Individual loot)" ((Get-CfgValue $HostCfg "World" "PersonalLoot").ToLower() -eq "true") 355 $yRight
    $yRight += 34

    $chkLockBuildings = Add-Checkbox "Lock Buildings to Owner" ((Get-CfgValue $HostCfg "World" "LockBuildingsToOwner").ToLower() -eq "true") 355 $yRight
    $yRight += 34

    $chkFreshOnly = Add-Checkbox "Level 1 Lock (Fresh characters only)" ((Get-CfgValue $GateCfg "Gate" "FreshCharactersOnly").ToLower() -eq "true") 355 $yRight
    $yRight += 34

    $chkPersonalRest = Add-Checkbox "Personal Bed Rest Fix (No server freeze)" ((Get-CfgValue $GateCfg "Gameplay" "EnablePersonalRest").ToLower() -ne "false") 355 $yRight
    $yRight += 38

    # Auto Save Interval
    $currAutoSave = Get-CfgValue $GateCfg "Gameplay" "AutoSaveIntervalMinutes"
    if (-not $currAutoSave) { $currAutoSave = "15" }
    $txtAutoSave = Add-StackedInput "Auto-Save Interval (Minutes, 0 = off):" $currAutoSave 355 $yRight 305 $false 4
    $yRight += 56

    # Info Box
    $pnlInfo = New-Object System.Windows.Forms.Panel
    $pnlInfo.Location = New-Object System.Drawing.Point(355, $yRight)
    $pnlInfo.Size = New-Object System.Drawing.Size(305, 140)
    $pnlInfo.BackColor = [System.Drawing.Color]::FromArgb(19, 25, 38)
    $pnlInfo.BorderStyle = "FixedSingle"
    $form.Controls.Add($pnlInfo)

    $lblInfo = New-Object System.Windows.Forms.Label
    $lblInfo.Text = "SERVER SETTINGS TIPS:`n`n• Level 1 Lock: Leave UNCHECKED for standard dedicated servers so players can join with existing characters. Check to force brand new Level 1 characters.`n• Friendly Fire: When checked, attacks damage players.`n• Bed Rest: Players heal in beds without freezing time."
    $lblInfo.Font = $tipFont
    $lblInfo.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
    $lblInfo.Location = New-Object System.Drawing.Point(8, 8)
    $lblInfo.Size = New-Object System.Drawing.Size(287, 122)
    $pnlInfo.Controls.Add($lblInfo)

    # Action Buttons
    $btnSave = New-Object System.Windows.Forms.Button
    $btnSave.Text = "SAVE SETTINGS"
    $btnSave.Font = $btnFont
    $btnSave.Location = New-Object System.Drawing.Point(20, 560)
    $btnSave.Size = New-Object System.Drawing.Size(640, 38)
    $btnSave.BackColor = [System.Drawing.Color]::FromArgb(6, 182, 212)
    $btnSave.ForeColor = [System.Drawing.Color]::FromArgb(10, 15, 26)
    $btnSave.FlatStyle = "Flat"
    $btnSave.Add_Click({
        $err1 = Validate-WorldName $txtWorld.Text
        if ($err1) { [System.Windows.Forms.MessageBox]::Show($err1, "Invalid Input", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning); return }
        $err2 = Validate-ServerName $txtServerName.Text
        if ($err2) { [System.Windows.Forms.MessageBox]::Show($err2, "Invalid Input", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning); return }
        $err3 = Validate-PlayerCap $txtPlayers.Text
        if ($err3) { [System.Windows.Forms.MessageBox]::Show($err3, "Invalid Input", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning); return }
        $err4 = Validate-JoinPassword $txtJoinPass.Text
        if ($err4) { [System.Windows.Forms.MessageBox]::Show($err4, "Invalid Input", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning); return }

        if ($ServerEdition -eq "WebAdmin" -and $txtAdminPass) {
            $err5 = Validate-AdminPassword $txtAdminPass.Text
            if ($err5) { [System.Windows.Forms.MessageBox]::Show($err5, "Invalid Input", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning); return }
            Set-CfgValue $AdminCfg "Admin" "Password" $txtAdminPass.Text.Trim()
        }

        # Save Host Cfg
        Set-CfgValue $HostCfg "Host" "ServerName" $txtServerName.Text.Trim()
        Set-CfgValue $HostCfg "Client" "ServerListName" $txtServerName.Text.Trim()
        Set-CfgValue $HostCfg "World" "Name" $txtWorld.Text.Trim()
        Set-CfgValue $HostCfg "Host" "MaxPlayers" $txtPlayers.Text.Trim()
        Set-CfgValue $HostCfg "Host" "JoinPassword" $txtJoinPass.Text.Trim()
        Set-CfgValue $HostCfg "World" "Difficulty" $cmbDiff.SelectedItem.ToString()
        Set-CfgValue $HostCfg "World" "FriendlyFire" ($chkFriendlyFire.Checked.ToString().ToLower())
        Set-CfgValue $HostCfg "World" "PersonalLoot" ($chkPersonalLoot.Checked.ToString().ToLower())
        Set-CfgValue $HostCfg "World" "LockBuildingsToOwner" ($chkLockBuildings.Checked.ToString().ToLower())

        if ($ServerEdition -eq "WebAdmin" -and $txtMotd) {
            Set-CfgValue $AdminCfg "Chat" "Motd" $txtMotd.Text.Trim()
        }

        # Save Gate Cfg
        Set-CfgValue $GateCfg "Server" "ServerNote" $txtNote.Text.Trim()
        Set-CfgValue $GateCfg "Gate" "FreshCharactersOnly" ($chkFreshOnly.Checked.ToString().ToLower())
        Set-CfgValue $GateCfg "Gameplay" "EnablePersonalRest" ($chkPersonalRest.Checked.ToString().ToLower())
        $autoSaveVal = "15"
        $parsedAuto = 0
        if ([int]::TryParse($txtAutoSave.Text.Trim(), [ref]$parsedAuto) -and $parsedAuto -ge 0) {
            $autoSaveVal = $parsedAuto.ToString()
        }
        Set-CfgValue $GateCfg "Gameplay" "AutoSaveIntervalMinutes" $autoSaveVal

        $flagPath = Join-Path $CoregateRoot ".configured"
        [System.IO.File]::WriteAllText($flagPath, (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), [System.Text.Encoding]::UTF8)

        [System.Windows.Forms.MessageBox]::Show("All settings saved successfully to Host and Coregate configs!", "COREGATE", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    })
    $form.Controls.Add($btnSave)

    $btnStart = New-Object System.Windows.Forms.Button
    $btnStart.Text = "[>]  START SERVER"
    $btnStart.Font = $btnFont
    $btnStart.Location = New-Object System.Drawing.Point(20, 608)
    $btnStart.Size = New-Object System.Drawing.Size(310, 42)
    $btnStart.BackColor = [System.Drawing.Color]::FromArgb(16, 185, 129)
    $btnStart.ForeColor = [System.Drawing.Color]::White
    $btnStart.FlatStyle = "Flat"
    $btnStart.Add_Click({
        Start-Coregate
        Start-Sleep -Seconds 1
        Refresh-GuiStatus
    })
    $form.Controls.Add($btnStart)

    $btnStop = New-Object System.Windows.Forms.Button
    $btnStop.Text = "[X]  STOP SERVER"
    $btnStop.Font = $btnFont
    $btnStop.Location = New-Object System.Drawing.Point(350, 608)
    $btnStop.Size = New-Object System.Drawing.Size(310, 42)
    $btnStop.BackColor = [System.Drawing.Color]::FromArgb(239, 68, 68)
    $btnStop.ForeColor = [System.Drawing.Color]::White
    $btnStop.FlatStyle = "Flat"
    $btnStop.Add_Click({
        Stop-Coregate
        Start-Sleep -Seconds 1
        Refresh-GuiStatus
    })
    $form.Controls.Add($btnStop)

    if ($ServerEdition -eq "WebAdmin") {
        $btnWeb = New-Object System.Windows.Forms.Button
        $btnWeb.Text = "[WEB]  OPEN WEB MAP & DASHBOARD"
        $btnWeb.Font = $btnFont
        $btnWeb.Location = New-Object System.Drawing.Point(20, 660)
        $btnWeb.Size = New-Object System.Drawing.Size(640, 36)
        $btnWeb.BackColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
        $btnWeb.ForeColor = [System.Drawing.Color]::FromArgb(56, 189, 248)
        $btnWeb.FlatStyle = "Flat"
        $btnWeb.Add_Click({
            Start-Process "http://localhost:$(Get-WebPort)/"
        })
        $form.Controls.Add($btnWeb)
    }

    $form.ShowDialog() | Out-Null
}

function Show-CmdMenu {
    while ($true) {
        Clear-Host
        $st = Get-ServerState
        $stStr = if ($st.Online) { "[ ONLINE - PID $($st.Pid) | RAM: $($st.Ram) MB ]" } else { "[ OFFLINE ]" }
        $stColor = if ($st.Online) { "Green" } else { "Red" }

        $world = Get-CfgValue $HostCfg "World" "Name"
        $players = Get-CfgValue $HostCfg "Host" "MaxPlayers"
        $srvName = Get-CfgValue $HostCfg "Host" "ServerName"
        $srvNote = Get-CfgValue $GateCfg "Server" "ServerNote"
        $motd = if ($ServerEdition -eq "WebAdmin") { Get-CfgValue $AdminCfg "Chat" "Motd" } else { "" }
        $pass = Get-CfgValue $HostCfg "Host" "JoinPassword"
        $passDisplay = if ($pass) { "********" } else { "(Open Server)" }
        $adminPass = Get-CfgValue $AdminCfg "Admin" "Password"
        $adminDisplay = if ($adminPass) { "********" } else { "(None - Web Console Locked)" }
        $diff = Get-CfgValue $HostCfg "World" "Difficulty"

        $pvp = if ((Get-CfgValue $HostCfg "World" "FriendlyFire").ToLower() -eq "true") { "ON" } else { "OFF" }
        $fresh = if ((Get-CfgValue $GateCfg "Gate" "FreshCharactersOnly").ToLower() -eq "true") { "ENFORCED (Lvl 1)" } else { "OPEN (Any Lvl)" }
        $loot = if ((Get-CfgValue $HostCfg "World" "PersonalLoot").ToLower() -eq "true") { "Personal" } else { "Shared" }
        $rest = if ((Get-CfgValue $GateCfg "Gameplay" "EnablePersonalRest").ToLower() -ne "false") { "Enabled" } else { "Vanilla" }

        # Resolve local IP
        $localIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch "^127\." -and $_.IPAddress -notmatch "^169\.254\." } | Select-Object -First 1).IPAddress
        if (-not $localIp) { $localIp = "127.0.0.1" }

        Write-Host "========================================================================" -ForegroundColor DarkCyan
        Write-Host "                       COREGATE SERVER CONTROL                          " -ForegroundColor Cyan
        Write-Host "                Dimraeth Dedicated Server Management Suite             " -ForegroundColor Gray
        Write-Host "========================================================================" -ForegroundColor DarkCyan
        Write-Host " STATUS: " -NoNewline
        Write-Host $stStr -ForegroundColor $stColor -NoNewline
        $gamePort = Get-CfgValue $HostCfg "Host" "GamePort"
        if (-not $gamePort) { $gamePort = "15569" }
        Write-Host " | World: $world | Port: $gamePort" -ForegroundColor Gray
        if ($ServerEdition -eq "WebAdmin") {
            $webPort = Get-WebPort
            Write-Host " Edition: Headless + Web Admin -> http://${localIp}:${webPort}/" -ForegroundColor DarkCyan
        } else {
            Write-Host " Edition: Pure Headless CLI (Minimal, zero web ports)" -ForegroundColor DarkGray
        }
        Write-Host "------------------------------------------------------------------------" -ForegroundColor DarkCyan
        Write-Host " [1] Server Display     : $srvName"
        Write-Host " [2] Server Lobby Note  : $srvNote"
        Write-Host " [3] Chat MOTD          : $(if ($motd) { $motd } else { '(None)' })"
        Write-Host " [4] World Name         : $world"
        Write-Host " [5] Max Players        : $players players"
        Write-Host " [6] Join Password      : $passDisplay"
        if ($ServerEdition -eq "WebAdmin") {
            Write-Host " [7] Admin Web Password : $adminDisplay"
        }
        Write-Host " [8] World Difficulty   : $diff"
        Write-Host " [R] Rules & Admission  : PvP=$pvp | Gate=$fresh | Loot=$loot | Rest=$rest"
        Write-Host "------------------------------------------------------------------------" -ForegroundColor DarkCyan
        Write-Host " [S] Start Server" -ForegroundColor Green
        Write-Host " [X] Stop Server" -ForegroundColor Red
        Write-Host " [T] Restart Server" -ForegroundColor Yellow
        Write-Host " [W] Run First-Run Setup Wizard" -ForegroundColor Magenta
        Write-Host " [G] Launch Visual Windows GUI Window" -ForegroundColor Cyan
        if ($ServerEdition -eq "WebAdmin") {
            Write-Host " [B] Open Live Web Map in Browser" -ForegroundColor Blue
        }
        Write-Host " [Q] Quit"
        Write-Host "========================================================================" -ForegroundColor DarkCyan
        $choice = Read-Host " Enter choice"

        switch ($choice.ToUpper()) {
            "1" {
                $newN = Read-Host " Enter Server Display Name (3-63 bytes)"
                $err = Validate-ServerName $newN
                if ($err) { Write-Host "[!] $err" -ForegroundColor Red; Start-Sleep -Seconds 2 }
                else { 
                    Set-CfgValue $HostCfg "Host" "ServerName" $newN.Trim()
                    Set-CfgValue $HostCfg "Client" "ServerListName" $newN.Trim()
                }
            }
            "2" {
                $newNote = Read-Host " Enter Server Lobby Note (shown in Steam browser)"
                Set-CfgValue $GateCfg "Server" "ServerNote" $newNote.Trim()
            }
            "3" {
                if ($ServerEdition -eq "WebAdmin") {
                    $newMotd = Read-Host " Enter Chat MOTD welcome message (or '-' to clear)"
                    if ($newMotd -eq "-") { $newMotd = "" }
                    Set-CfgValue $AdminCfg "Chat" "Motd" $newMotd.Trim()
                } else {
                    Write-Host "[!] Chat MOTD is managed by WebAdmin edition." -ForegroundColor Yellow
                    Start-Sleep -Seconds 2
                }
            }
            "4" {
                $newW = Read-Host " Enter new World Name (2-32 chars)"
                $err = Validate-WorldName $newW
                if ($err) { Write-Host "[!] $err" -ForegroundColor Red; Start-Sleep -Seconds 2 }
                else { Set-CfgValue $HostCfg "World" "Name" $newW.Trim() }
            }
            "5" {
                $newP = Read-Host " Enter Max Players (1-32)"
                $err = Validate-PlayerCap $newP
                if ($err) { Write-Host "[!] $err" -ForegroundColor Red; Start-Sleep -Seconds 2 }
                else { Set-CfgValue $HostCfg "Host" "MaxPlayers" $newP.Trim() }
            }
            "6" {
                $newPass = Read-Host " Enter Join Password (or leave empty for open server)"
                $err = Validate-JoinPassword $newPass
                if ($err) { Write-Host "[!] $err" -ForegroundColor Red; Start-Sleep -Seconds 2 }
                else { Set-CfgValue $HostCfg "Host" "JoinPassword" $newPass.Trim() }
            }
            "7" {
                if ($ServerEdition -eq "WebAdmin") {
                    $newAdmin = Read-Host " Enter Admin Web Password (4-64 chars)"
                    $err = Validate-AdminPassword $newAdmin
                    if ($err) { Write-Host "[!] $err" -ForegroundColor Red; Start-Sleep -Seconds 2 }
                    else { Set-CfgValue $AdminCfg "Admin" "Password" $newAdmin.Trim() }
                } else {
                    Write-Host "[!] Admin Web Password is not used in Pure Headless CLI edition." -ForegroundColor Yellow
                    Start-Sleep -Seconds 2
                }
            }
            "8" {
                Write-Host " Choose: [1] Moderate  [2] Easy  [3] Hard"
                $dChoice = Read-Host " Select"
                if ($dChoice -eq "1") { Set-CfgValue $HostCfg "World" "Difficulty" "Moderate" }
                elseif ($dChoice -eq "2") { Set-CfgValue $HostCfg "World" "Difficulty" "Easy" }
                elseif ($dChoice -eq "3") { Set-CfgValue $HostCfg "World" "Difficulty" "Hard" }
            }
            "R" {
                Write-Host "`n--- TOGGLE RULES & ADMISSION ---" -ForegroundColor Cyan
                Write-Host " [1] Toggle Friendly Fire (PvP) [Current: $pvp]"
                Write-Host " [2] Toggle Level 1 Lock (Fresh Only) [Current: $fresh]"
                Write-Host " [3] Toggle Personal Loot [Current: $loot]"
                Write-Host " [4] Toggle Personal Bed Rest Fix [Current: $rest]"
                $rChoice = Read-Host " Choose rule to toggle (1-4)"
                switch ($rChoice) {
                    "1" {
                        $newVal = if ($pvp -eq "ON") { "false" } else { "true" }
                        Set-CfgValue $HostCfg "World" "FriendlyFire" $newVal
                        Write-Host " Friendly Fire set to $newVal" -ForegroundColor Green
                        Start-Sleep -Seconds 1
                    }
                    "2" {
                        $newVal = if ($fresh -match "ENFORCED") { "false" } else { "true" }
                        Set-CfgValue $GateCfg "Gate" "FreshCharactersOnly" $newVal
                        Write-Host " Fresh Characters Only set to $newVal" -ForegroundColor Green
                        Start-Sleep -Seconds 1
                    }
                    "3" {
                        $newVal = if ($loot -eq "Personal") { "false" } else { "true" }
                        Set-CfgValue $HostCfg "World" "PersonalLoot" $newVal
                        Write-Host " Personal Loot set to $newVal" -ForegroundColor Green
                        Start-Sleep -Seconds 1
                    }
                    "4" {
                        $newVal = if ($rest -eq "Enabled") { "false" } else { "true" }
                        Set-CfgValue $GateCfg "Gameplay" "EnablePersonalRest" $newVal
                        Write-Host " Personal Rest Fix set to $newVal" -ForegroundColor Green
                        Start-Sleep -Seconds 1
                    }
                }
            }
            "S" { Start-Coregate; Start-Sleep -Seconds 2 }
            "X" { Stop-Coregate; Start-Sleep -Seconds 2 }
            "T" { Stop-Coregate; Start-Sleep -Seconds 2; Start-Coregate; Start-Sleep -Seconds 2 }
            "W" { Run-FirstRunWizard }
            "G" { Show-GuiWindow }
            "B" { 
                if ($ServerEdition -eq "WebAdmin") {
                    Start-Process "http://localhost:$(Get-WebPort)/" 
                } else {
                    Write-Host "[!] Web Dashboard is disabled in Pure Headless CLI edition." -ForegroundColor Yellow
                    Start-Sleep -Seconds 2
                }
            }
            "Q" { return }
        }
    }
}

# Entrypoint Execution
if ($Start) { Start-Coregate; return }
if ($Stop) { Stop-Coregate; return }
if ($Restart) { Stop-Coregate; Start-Sleep -Seconds 2; Start-Coregate; return }
if ($Status) {
    $st = Get-ServerState
    if ($st.Online) { Write-Host "ONLINE (PID $($st.Pid), $($st.Ram) MB)" -ForegroundColor Green }
    else { Write-Host "OFFLINE" -ForegroundColor Red }
    return
}

# First-run check: if no .configured flag exists and not in GUI mode, run console wizard
if ($Setup -or ((-not (Test-Path "$CoregateRoot\.configured")) -and (-not $Gui))) {
    Run-FirstRunWizard
}

if ($Gui) {
    Show-GuiWindow
} else {
    Show-CmdMenu
}
