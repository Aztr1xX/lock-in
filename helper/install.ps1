# Installs the Lock In game closer for this Windows user and starts it.
$ErrorActionPreference = 'Stop'
$dest = Join-Path $env:LOCALAPPDATA 'LockIn'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($f in 'LockInHelper.ps1', 'tray.ps1', 'lockin.ico', 'start-hidden.vbs') {
    Copy-Item -Force (Join-Path $PSScriptRoot $f) (Join-Path $dest $f)
}

# Start with Windows, with no console window flashing up.
$startup = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $startup 'Lock In Helper.lnk'))
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = '"' + (Join-Path $dest 'start-hidden.vbs') + '"'
$lnk.IconLocation = Join-Path $dest 'lockin.ico'
$lnk.Description = 'Lock In game closer'
$lnk.Save()

Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $dest 'start-hidden.vbs') + '"')

Write-Host ''
Write-Host '  Lock In game closer is installed.' -ForegroundColor Green
Write-Host '  Look for the green ring in your system tray (click ^ by the clock if it is hidden).'
Write-Host '  It starts by itself with Windows from now on.'
Write-Host ''
