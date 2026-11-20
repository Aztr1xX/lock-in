# Lock In desktop app

The all-in-one Windows version of Lock In: tray app, timer, system-wide blocking and the garden.
This folder is phase 0: a test build that proves the risky parts on a real PC.

- `src/` the app's screens (Svelte 5 + TypeScript)
- `src-tauri/` the app's core (Tauri 2, Rust): tray, window, talks to the Guard
- `guard/` Lock In Guard, a small Windows service that blocks sites through the hosts file and closes games
- `camera/` the camera worker (`lockin-camera.exe`): runs the camera models with ONNX Runtime on frames it
  is handed and reports numbers only. No network code (CI checks its dependencies). `camera/models/export.py`
  makes the ONNX models in CI and publishes them, with ONNX Runtime's DirectML build, as the
  `camera-models-1` pre-release; `scripts/camera-assets.ps1` fetches them for builds into `src-tauri/camera/`
- `scripts/smoke.ps1` installs the Guard, blocks a site, closes Notepad and removes it again (runs in CI)

GitHub Actions builds the installer on every push that touches this folder
(`.github/workflows/desktop.yml`); download it from the run's artifacts.

Local development on Windows: `npm install`, build the Guard with `cargo build -p lockin-guard --release`,
copy it to `src-tauri/binaries/lockin-guard-x86_64-pc-windows-msvc.exe`, then `npx tauri dev`.

## Updates

Installed copies check `latest.json` on this repo's latest release every
6 hours, download a newer signed version in the background and offer "Restart to update".
To ship one: change the number in `release-version.txt` and push (`.github/workflows/desktop-release.yml` does the rest).
The updater's public key is in `src-tauri/tauri.conf.json`; the private key lives only in the
`TAURI_SIGNING_PRIVATE_KEY` secret and Ryan's own backup.
