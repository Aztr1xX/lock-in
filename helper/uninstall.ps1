# Removes the Lock In game closer.
$startup = [Environment]::GetFolderPath('Startup')
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $startup 'Lock In Helper.lnk')
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like '*LockInHelper.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:LOCALAPPDATA 'LockIn')
Write-Host 'Lock In game closer removed.'
