# Fetches the camera models and ONNX Runtime from the camera-models-1 pre-release (made by
# .github/workflows/camera-models.yml) and lays them out for the build:
#   camera-assets/        everything, for the CI speed test
#   src-tauri/camera/     what the installer ships (no timing-only models such as YOLO26n)
# Run from desktop/ with GH_TOKEN set.
param([string]$Tag = "camera-models-1")
$ErrorActionPreference = "Stop"

gh release download $Tag --repo $env:GITHUB_REPOSITORY --dir camera-assets --clobber
if ($LASTEXITCODE -ne 0) { throw "Could not download the $Tag release. Run the Camera models workflow first." }

$manifest = Get-Content camera-assets/manifest.json -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force src-tauri/camera/models | Out-Null
foreach ($f in "onnxruntime.dll", "DirectML.dll", "ORT-LICENSE.txt", "ORT-ThirdPartyNotices.txt") {
  Copy-Item "camera-assets/$f" src-tauri/camera/
}
Copy-Item camera-assets/manifest.json src-tauri/camera/models/
foreach ($m in $manifest.models) {
  if ($m.timing_only) { Write-Host "not shipped (timing only): $($m.file)"; continue }
  Copy-Item "camera-assets/$($m.file)" src-tauri/camera/models/
  Write-Host ("shipped: {0} ({1:N0} MB)" -f $m.file, ($m.bytes / 1MB))
}
