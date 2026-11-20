# Smoke test for Lock In Guard on a Windows machine with admin rights (GitHub's runners have it).
# Installs the service, blocks a site, checks Windows now resolves it to the Guard, checks the
# Guard saw the attempt, closes Notepad through it, then removes everything.
$ErrorActionPreference = "Stop"
$guard = Resolve-Path "target/release/lockin-guard.exe"

function Guard($obj) {
  $c = [System.Net.Sockets.TcpClient]::new("127.0.0.1", 47822)
  $c.ReceiveTimeout = 45000
  $s = $c.GetStream()
  $w = [IO.StreamWriter]::new($s); $w.AutoFlush = $true
  $w.WriteLine(($obj | ConvertTo-Json -Compress))
  $line = [IO.StreamReader]::new($s).ReadLine()
  $c.Close()
  return $line | ConvertFrom-Json
}
function Step($what) { Write-Host "....  $what" }
function Check($ok, $what) {
  if ($ok) { Write-Host "PASS  $what" } else { Write-Host "FAIL  $what"; $script:failed = $true }
}
$failed = $false

& $guard install
if ($LASTEXITCODE -ne 0) { throw "install failed" }
Start-Sleep -Seconds 2
$st = Guard @{ cmd = "status" }
Check ($st.ok) "service answers (version $($st.version), sinkhole: $($st.sinkhole -join ' '))"

$y = Guard @{ cmd = "yt_search"; q = "minecraft hardcore" }
Check ($y.ok -and $y.verdict -eq "fun" -and @($y.results).Count -eq 0) "study YouTube refuses a fun search"
$r = Guard @{ cmd = "block"; hosts = @("example.com", "example.org", "wikipedia.org", "youtube.com"); minutes = 1.5 }
Check ($r.ok -and $r.hosts -contains "www.example.com") "block accepted ($($r.hosts -join ', '))"
$st = Guard @{ cmd = "status" }
Check ($st.hostsOk) "hosts section still in place"
Write-Host "      layers: $($st.layers -join ', ')"
Check ($st.layers -contains "Chrome" -and $st.layers -contains "Edge" -and $st.layers -contains "Firewall" -and $st.layers -contains "Page") "secure DNS off, firewall and page layers are on"
$doh = Get-ItemProperty "HKLM:\SOFTWARE\Policies\Google\Chrome" -Name DnsOverHttpsMode -ErrorAction SilentlyContinue
Check ($doh.DnsOverHttpsMode -eq "off") "Chrome secure DNS is off for the round"
$ca = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*Lock In focus round*" }
Check (@($ca).Count -eq 1) "the round certificate is trusted ($(@($ca).Count) found)"
# curl on Windows checks certificates against Windows' trusted list, like Chrome, Edge and Opera.
# (--ssl-no-revoke: browsers carry on when a certificate has no revocation list; curl would not.)
Step "fetching a blocked HTTPS site"
$pg = curl.exe -s --ssl-no-revoke --max-time 8 https://www.example.com/ | Out-String
Check ($pg -match "This can wait") "an HTTPS blocked site shows the Lock In page with a valid certificate"
$rule = netsh advfirewall firewall show rule name=LockInFocusRound
Check ($LASTEXITCODE -eq 0) "firewall rule is in place"
$doh = [System.Net.Dns]::GetHostAddresses("dns.google") | ForEach-Object { $_.ToString() }
Check (($doh | Where-Object { $_ -ne "127.0.0.1" -and $_ -ne "::1" }).Count -eq 0) "secure DNS server name is blocked ($($doh -join ', '))"
$chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
function ChromeDom($url) {
  # chrome.exe is a GUI program, so its output has to be redirected to a file to be read.
  $out = Join-Path $env:TEMP "lockin-dom.txt"
  Remove-Item $out -ErrorAction SilentlyContinue
  $p = Start-Process $chrome -ArgumentList "--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=$env:TEMP\lockin-chrome", "--dump-dom", $url -RedirectStandardOutput $out -PassThru -WindowStyle Hidden
  if (-not $p.WaitForExit(40000)) {
    Write-Host "      (chrome took too long; stopping it)"
    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
  }
  return (Get-Content $out -Raw -ErrorAction SilentlyContinue) + ""
}
Check ($st.layers -contains "Names") "name layer (WinDivert) is on"
# A browser with its own DNS skips the hosts file. Pretend to be one: connect straight to the real
# address of a blocked site. Only the name layer can stop this.
$real = (Resolve-DnsName example.org -Server 8.8.8.8 -Type A -DnsOnly | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
curl.exe -s --max-time 8 --resolve "example.org:443:$real" https://example.org/ -o direct.html
Check ($LASTEXITCODE -ne 0) "own-DNS connection to a blocked site is stopped by name ($real, curl exit $LASTEXITCODE)"
curl.exe -s --max-time 8 https://en.wikipedia.org/ -o wiki.html
Check ($LASTEXITCODE -ne 0) "a subdomain not in the hosts file is stopped by name (curl exit $LASTEXITCODE)"
curl.exe -s --max-time 8 -o NUL https://www.iana.org/
Check ($LASTEXITCODE -eq 0) "other sites still load during the block"
# Study YouTube has to keep working while youtube.com is blocked for everything else.
Step "study YouTube search"
$y = Guard @{ cmd = "yt_search"; q = "organic chemistry alkenes" }
$allowed = @($y.results | Where-Object { $_.allowed })
Write-Host "      study search: ok=$($y.ok) verdict=$($y.verdict) results=$(@($y.results).Count) allowed=$($allowed.Count) error=$($y.error)"
if ($y.results) { $y.results | Select-Object -First 4 | ForEach-Object { Write-Host "        $($_.category) | $($_.title) $($_.problem)" } }
Check ($y.ok -and @($y.results).Count -ge 3 -and $allowed.Count -ge 1) "study YouTube search works during a YouTube block"
$hasChrome = Test-Path $chrome
if ($hasChrome) {
  # en.wikipedia.org isn't in the hosts file, so only the browser policy can stop it.
  Start-Sleep -Seconds 3
  Step "chrome: blocked subdomain"
  $domBlocked = ChromeDom "https://en.wikipedia.org/"
  Write-Host "      chrome during the block: $($domBlocked.Length) chars"
  Step "chrome: blocked site page"
  $domPage = ChromeDom "https://www.example.org/"
  Check ($domPage -match "This can wait") "Chrome shows the Lock In page for a blocked site"
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
$doh = Get-ItemProperty "HKLM:\SOFTWARE\Policies\Google\Chrome" -Name DnsOverHttpsMode -ErrorAction SilentlyContinue
Check (-not $doh) "Chrome secure DNS setting removed"
for ($i = 0; $i -lt 15; $i++) {
  $ca = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*Lock In focus round*" }
  if (@($ca).Count -eq 0) { break }
  Start-Sleep -Seconds 1
}
Check (@($ca).Count -eq 0) "the round certificate is gone"
netsh advfirewall firewall show rule name=LockInFocusRound | Out-Null
Check ($LASTEXITCODE -ne 0) "firewall rule removed"
curl.exe -s --max-time 8 -o NUL https://en.wikipedia.org/
Check ($LASTEXITCODE -eq 0) "the subdomain loads again after the block"
if ($hasChrome) {
  Start-Sleep -Seconds 3
  $domFree = ChromeDom "https://en.wikipedia.org/"
  Write-Host "      chrome after the block: $($domFree.Length) chars"
  Check (($domFree -match "Wikipedia") -and -not ($domBlocked -match "Wikipedia")) "Chrome couldn't open a blocked subdomain, and could afterwards"
}

& $guard uninstall
Check ($LASTEXITCODE -eq 0) "uninstall"
Get-Content "$env:ProgramData\LockIn\guard.log" -ErrorAction SilentlyContinue | Select-Object -Last 15
if ($failed) { exit 1 }
