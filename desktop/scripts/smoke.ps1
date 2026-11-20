# Smoke test for Lock In Guard on a Windows machine with admin rights (GitHub's runners have it).
# Installs the service, blocks a site, checks Windows now resolves it to the Guard, checks the
# Guard saw the attempt, closes Notepad through it, then removes everything.
$ErrorActionPreference = "Stop"
$guard = Resolve-Path "target/release/lockin-guard.exe"

function Guard($obj) {
  $c = [System.Net.Sockets.TcpClient]::new("127.0.0.1", 47822)
  $s = $c.GetStream()
  $w = [IO.StreamWriter]::new($s); $w.AutoFlush = $true
  $w.WriteLine(($obj | ConvertTo-Json -Compress))
  $line = [IO.StreamReader]::new($s).ReadLine()
  $c.Close()
  return $line | ConvertFrom-Json
}
function Check($ok, $what) {
  if ($ok) { Write-Host "PASS  $what" } else { Write-Host "FAIL  $what"; $script:failed = $true }
}
$failed = $false

& $guard install
if ($LASTEXITCODE -ne 0) { throw "install failed" }
Start-Sleep -Seconds 2
$st = Guard @{ cmd = "status" }
Check ($st.ok) "service answers (version $($st.version), sinkhole: $($st.sinkhole -join ' '))"

$r = Guard @{ cmd = "block"; hosts = @("example.com", "example.org", "wikipedia.org"); minutes = 0.75 }
Check ($r.ok -and $r.hosts -contains "www.example.com") "block accepted ($($r.hosts -join ', '))"
$st = Guard @{ cmd = "status" }
Check ($st.hostsOk) "hosts section still in place"
Write-Host "      layers: $($st.layers -join ', ')"
Check ($st.layers -contains "Chrome" -and $st.layers -contains "Edge" -and $st.layers -contains "Firewall") "browser policy and firewall layers are on"
$pol = Get-ItemProperty "HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist" -ErrorAction SilentlyContinue
Check ($pol -and (@($pol.PSObject.Properties.Value) -contains "wikipedia.org")) "Chrome policy lists wikipedia.org"
$rule = netsh advfirewall firewall show rule name=LockInFocusRound
Check ($LASTEXITCODE -eq 0) "firewall rule is in place"
$doh = [System.Net.Dns]::GetHostAddresses("dns.google") | ForEach-Object { $_.ToString() }
Check (($doh | Where-Object { $_ -ne "127.0.0.1" -and $_ -ne "::1" }).Count -eq 0) "secure DNS server name is blocked ($($doh -join ', '))"
$chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
if (Test-Path $chrome) {
  # en.wikipedia.org isn't in the hosts file, so only the browser policy can stop it.
  Start-Sleep -Seconds 3
  $dom = & $chrome --headless=new --disable-gpu --no-first-run --user-data-dir="$env:TEMP\lockin-chrome" --dump-dom https://en.wikipedia.org/ 2>$null | Out-String
  Write-Host ("      chrome said: " + ($dom -replace "\s+"," ").Substring(0, [Math]::Min(160, $dom.Length)))
  Check ($dom -match "BLOCKED_BY_ADMINISTRATOR") "Chrome blocks a subdomain through the policy"
}
$hosts = Get-Content "$env:SystemRoot\System32\drivers\etc\hosts" -Raw
Check ($hosts -match "127\.0\.0\.1 example\.com") "hosts file has the Lock In section"
$ips = [System.Net.Dns]::GetHostAddresses("example.com") | ForEach-Object { $_.ToString() }
Check (($ips | Where-Object { $_ -ne "127.0.0.1" -and $_ -ne "::1" }).Count -eq 0) "example.com now resolves to the Guard ($($ips -join ', '))"

curl.exe -s --max-time 5 https://example.com/ | Out-Null
if ($st.sinkhole -contains "127.0.0.1:80") {
  curl.exe -s --max-time 5 http://example.org/ -o page.html
  Check ((Get-Content page.html -Raw) -match "Locked in") "plain http shows the Locked in page"
} else {
  # Windows often reserves port 80 for its own web server (http.sys). Plain-http sites are then
  # still blocked, they just show the browser's error page instead of ours. Nearly every site is https anyway.
  Write-Host "SKIP  plain http page (port 80 is reserved on this machine)"
}
$st = Guard @{ cmd = "status" }
$seen = $st.attempts | ForEach-Object { $_.host }
Check ($seen -contains "example.com") "HTTPS attempt was seen through SNI ($($seen -join ', '))"

$np = Start-Process notepad -PassThru
Start-Sleep -Seconds 2
$k = Guard @{ cmd = "kill"; names = @("notepad.exe") }
Start-Sleep -Seconds 1
Check ($k.killed.Count -ge 1 -and $np.HasExited) "Notepad closed through the Guard"

Write-Host "Waiting for the block to end on its own..."
do { Start-Sleep -Seconds 2; $st = Guard @{ cmd = "status" } } while ($st.blocking)
Start-Sleep -Seconds 2
$hosts = Get-Content "$env:SystemRoot\System32\drivers\etc\hosts" -Raw
Check (-not ($hosts -match "Lock In")) "block ended on time and the hosts file is clean"
Check (-not (Test-Path "HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist")) "Chrome policy removed"
Check (-not (Test-Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist")) "Edge policy removed"
netsh advfirewall firewall show rule name=LockInFocusRound | Out-Null
Check ($LASTEXITCODE -ne 0) "firewall rule removed"

& $guard uninstall
Check ($LASTEXITCODE -eq 0) "uninstall"
Get-Content "$env:ProgramData\LockIn\guard.log" -ErrorAction SilentlyContinue | Select-Object -Last 15
if ($failed) { exit 1 }
