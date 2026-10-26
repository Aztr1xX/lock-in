# Tray icon and Windows message loop. Loaded only on Windows, after the Forms types exist.
$icoPath = Join-Path $PSScriptRoot 'lockin.ico'
$script:Tray = New-Object System.Windows.Forms.NotifyIcon
$script:Tray.Icon = if (Test-Path $icoPath) { New-Object System.Drawing.Icon($icoPath) } else { [System.Drawing.SystemIcons]::Application }
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:StatusItem = $menu.Items.Add('Waiting for a session')
$script:StatusItem.Enabled = $false
[void]$menu.Items.Add('-')
$watch = $menu.Items.Add('Closes: Steam, Minecraft, Valorant')
$watch.Enabled = $false
$quit = $menu.Items.Add('Quit')
$quit.add_Click({
    if (IsLocked) { Notify "Can't quit right now" 'Finish your session in Lock In first.'; return }
    $script:Tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
$script:Tray.ContextMenuStrip = $menu
$script:Tray.Visible = $true
UpdateTray

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.add_Tick({ try { Tick } catch { } })
$timer.Start()
[System.Windows.Forms.Application]::Run()
$script:Tray.Dispose()
