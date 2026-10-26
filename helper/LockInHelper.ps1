# Lock In game closer.
# Sits in the system tray. While a Lock In session is running it closes Steam,
# Minecraft and Valorant if they open. The Lock In Blocker extension tells it when
# a session starts and ends, over a private connection on this PC only (port 47821).
# Works with the Windows PowerShell 5.1 that comes with Windows.

$ErrorActionPreference = 'Stop'
$Version = '0.1.0'
$Port = 47821
$IsWin = ($env:OS -eq 'Windows_NT')

# Only one copy at a time.
$mutex = New-Object System.Threading.Mutex($false, 'Local\LockInHelper')
if (-not $mutex.WaitOne(0)) { exit }

# Games to close, with the name shown in the notification.
# Minecraft Java runs as javaw.exe, so that one is matched by window title too.
$Targets = @(
    @{ Name = 'Steam';     Processes = @('steam', 'steamwebhelper') },
    @{ Name = 'Minecraft'; Processes = @('MinecraftLauncher', 'Minecraft', 'Minecraft.Windows'); JavaTitle = 'Minecraft*' },
    @{ Name = 'Valorant';  Processes = @('VALORANT', 'VALORANT-Win64-Shipping', 'RiotClientServices', 'Riot Client', 'RiotClientUx') }
)

$script:LockUntil = [int64]0
$script:Subject = ''
$script:Closed = New-Object System.Collections.ArrayList

function NowMs { [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }
function IsLocked { $script:LockUntil -gt (NowMs) }

$Lines = @(
    "Back to it. You've got this.",
    'Nice try. Games after the session.',
    'Stay locked in.',
    'It will still be there later.',
    'Future you says thanks.'
)

function Notify($title, $text) {
    if ($script:Tray) { $script:Tray.ShowBalloonTip(4000, $title, $text, [System.Windows.Forms.ToolTipIcon]::Info) }
    else { Write-Host "[notify] $title - $text" }
}

function Sweep {
    if (-not (IsLocked)) { return }
    foreach ($t in $Targets) {
        $found = @()
        foreach ($p in $t.Processes) {
            $found += @(Get-Process -Name $p -ErrorAction SilentlyContinue)
        }
        if ($t.JavaTitle) {
            $found += @(Get-Process -Name 'javaw', 'java' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like $t.JavaTitle })
        }
        if ($found.Count -gt 0) {
            foreach ($proc in $found) { try { $proc.Kill() } catch { } }
            [void]$script:Closed.Add(@{ name = $t.Name; at = (NowMs) })
            $line = $Lines[(Get-Random -Maximum $Lines.Count)]
            $what = if ($script:Subject) { "$($script:Subject) session is still running. " } else { '' }
            Notify "$($t.Name) closed" "$what$line"
        }
    }
}

function Send($ctx, [int]$code, $obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 4
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $ctx.Response.StatusCode = $code
    $ctx.Response.ContentType = 'application/json'
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.Close()
}

function Status {
    @{ ok = $true; app = 'lockin-helper'; version = $Version; locked = (IsLocked); lockUntil = $script:LockUntil; closed = @($script:Closed | Select-Object -Last 5) }
}

function Handle($ctx) {
    $req = $ctx.Request
    try {
        # The header can't be sent by an ordinary web page without permission, so only
        # the Lock In extension (or you, on purpose) can drive this.
        if ($req.Headers['X-LockIn'] -ne '1') { Send $ctx 403 @{ ok = $false; error = 'forbidden' }; return }
        $path = $req.Url.AbsolutePath
        if ($req.HttpMethod -eq 'GET' -and $path -eq '/status') { Send $ctx 200 (Status); return }
        if ($req.HttpMethod -eq 'POST' -and $path -eq '/session') {
            $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
            $body = $reader.ReadToEnd() | ConvertFrom-Json
            $was = IsLocked
            if ($body.active) {
                $script:LockUntil = [int64]$body.lockUntil
                $script:Subject = [string]$body.subject
            } else {
                $script:LockUntil = 0
                $script:Subject = ''
            }
            if ((IsLocked) -and -not $was) { UpdateTray; Sweep }
            if (-not (IsLocked) -and $was) { UpdateTray; Notify 'Session over' 'Games are unlocked. Nice work.' }
            Send $ctx 200 (Status)
            return
        }
        Send $ctx 404 @{ ok = $false; error = 'not found' }
    } catch {
        try { Send $ctx 500 @{ ok = $false; error = "$_" } } catch { }
    }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
$script:Pending = $listener.GetContextAsync()

function Pump {
    while ($script:Pending.IsCompleted) {
        $ctx = $null
        try { $ctx = $script:Pending.Result } catch { }
        $script:Pending = $listener.GetContextAsync()
        if ($ctx) { Handle $ctx }
    }
}

$script:LastSweep = [int64]0
$script:WasLocked = $false
function Tick {
    Pump
    $now = NowMs
    $locked = IsLocked
    if ($locked -ne $script:WasLocked) { $script:WasLocked = $locked; UpdateTray }
    if ($locked -and ($now - $script:LastSweep) -ge 2000) { $script:LastSweep = $now; Sweep }
}

$script:Tray = $null
function UpdateTray {
    if (-not $script:Tray) { return }
    if (IsLocked) {
        $script:Tray.Text = 'Lock In: closing games until your session ends'
        $script:StatusItem.Text = if ($script:Subject) { "Locked in: $($script:Subject)" } else { 'Locked in' }
    } else {
        $script:Tray.Text = 'Lock In: waiting for a session'
        $script:StatusItem.Text = 'Waiting for a session'
    }
}

if ($IsWin) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    . (Join-Path $PSScriptRoot 'tray.ps1')
} else {
    # Test mode for non-Windows machines: no tray, same behaviour.
    Write-Host "Lock In helper (test mode) on port $Port"
    while ($true) { Tick; Start-Sleep -Milliseconds 100 }
}

$listener.Stop()
$mutex.ReleaseMutex()
