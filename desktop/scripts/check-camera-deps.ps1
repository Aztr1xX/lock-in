# Privacy rule from the camera plan: the camera worker has no network code at all. This fails the
# build if any crate it depends on can open network connections.
$ErrorActionPreference = "Stop"
$tree = cargo tree -p lockin-camera -e normal --prefix none --no-dedupe --target all | ForEach-Object { ($_ -split ' ')[0] } | Sort-Object -Unique
$banned = "reqwest", "hyper", "ureq", "curl", "isahc", "attohttpc", "tokio", "mio", "socket2", "native-tls", "rustls", "openssl", "h2", "tungstenite", "surf", "minreq", "windows-sockets"
$found = @($tree | Where-Object { $banned -contains $_ })
Write-Host "lockin-camera depends on $($tree.Count) crates"
if ($found.Count) { throw "The camera worker must not depend on networking crates, found: $($found -join ', ')" }
Write-Host "PASS  no networking crates in the camera worker"
