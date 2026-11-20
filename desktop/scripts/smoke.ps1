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
# YouTube stays open for studying: the Guard passes it through with the feed and fun taken out.
# Ask like a browser opening a page, so YouTube sends its full page and the Guard treats it as one.
function Yt($path) { return (curl.exe -s --ssl-no-revoke --max-time 25 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" -H "Accept: text/html" -H "Sec-Fetch-Dest: document" -H "Accept-Language: en-US" "https://www.youtube.com$path" | Out-String) }
Step "study-only YouTube"
$ythome = Yt "/"
Check ($ythome -match "lockin-study" -and $ythome -notmatch "This can wait") "youtube.com opens with the feed hidden ($($ythome.Length) chars)"
$sh = curl.exe -s --ssl-no-revoke --max-time 10 -D - -o NUL https://www.youtube.com/shorts/dQw4w9WgXcQ | Out-String
Check ($sh -match "Location: /watch\?v=dQw4w9WgXcQ") "Shorts open as normal videos, so they get checked too"
$short = curl.exe -s --ssl-no-revoke --max-time 10 -D - -o NUL https://youtu.be/dQw4w9WgXcQ | Out-String
Check ($short -match "Location: https://www.youtube.com/watch\?v=dQw4w9WgXcQ") "youtu.be links lead to the checked video page"
Check ((Yt "/results?search_query=minecraft+hardcore") -match "That search can wait") "a fun search is held back"
$ss = Yt "/results?search_query=integration+by+parts+lesson"
# The results can come as plain JSON or as an escaped string (\x22 for quotes).
$ids = @([regex]::Matches($ss, '(?:"|\\x22)videoId(?:"|\\x22):(?:"|\\x22)([A-Za-z0-9_-]{11})') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique -First 5)
$i = $ss.IndexOf("ytInitialData")
Write-Host "      results page: $($ss.Length) chars; $(if ($i -ge 0) { $ss.Substring($i, [Math]::Min(160, $ss.Length - $i)) } else { 'no ytInitialData' })"
Check ($ss -match "lockin-study" -and $ids.Count -ge 3) "a study search shows results ($($ids.Count) videos)"
$open = 0
foreach ($id in $ids) {
  $w = Yt "/watch?v=$id"
  $t = [regex]::Match($w, '<meta name="title" content="([^"]*)"').Groups[1].Value
  $ok = $w -notmatch "This video can wait" -and $w -match "lockin-study"
  Write-Host "        plays=$ok | $t"
  if ($ok) { $open++ }
}
Check ($open -ge 1) "study videos open ($open of $($ids.Count))"
Check ((Yt "/watch?v=dQw4w9WgXcQ") -match "This video can wait") "a music video is held back"
Set-Content -Path player.json -Value '{"videoId":"dQw4w9WgXcQ","context":{"client":{"clientName":"WEB","clientVersion":"2.20251119.01.00","hl":"en","gl":"US"}}}' -NoNewline
$pl = curl.exe -s --ssl-no-revoke --max-time 15 -H "Content-Type: application/json" --data-binary "@player.json" "https://www.youtube.com/youtubei/v1/player?prettyPrint=false" | Out-String
$status = [regex]::Match($pl, '"playabilityStatus":\{"status":"([A-Z_]+)"').Groups[1].Value
Write-Host "      player answer: $($pl.Length) chars, status $status, details $($pl -match '"videoDetails"')"
Check ($pl -match "This can wait" -or $pl -notmatch '"videoDetails"') "the player won't play a music video clicked inside YouTube"
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
  Step "chrome: study-only YouTube"
  $domYt = ChromeDom "https://www.youtube.com/"
  Check ($domYt -match "lockin-study") "Chrome opens study-only YouTube ($($domYt.Length) chars)"
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
