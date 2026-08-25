# Codex Handoff — Package and Smoke-Test Latest Codex BEG

Continue in:

`/Users/11397288/DevProjects/gpt-mcp`

Do not discard any existing working-tree changes.

Do not run `git reset`, `git clean`, `git restore`, discard/checkout changes, or delete project files.
Do not commit or push unless explicitly requested.
Do not expose or print Runtime API keys.

## Current source state

The latest source now includes the requested operator UX:

- minimal Overview / Projects / Activity / Connection / Diagnostics UI
- active project is read from actual workspace state
- workspace changes render immediately plus bounded reconciliation polling
- Agent/MCP/Tunnel live status
- Agent Host stdout + stderr pushed to Activity immediately over IPC
- tunnel status monitored from Electron main even when the window is hidden
- Tunnel ID + masked Runtime API key configuration in the UI
- Runtime API key stored encrypted through Electron `safeStorage`; renderer never receives the saved key
- Tunnel ID/runtime key verification via read-only `tunnel-client admin --json tunnels get <id>` with `CONTROL_PLANE_API_KEY` and ambient admin/fallback keys stripped from the child env
- managed `tunnel-client runtimes connect/status/stop` flow
- literal runtime key is not placed in argv; connect uses `env:CONTROL_PLANE_API_KEY`
- Start Tunnel is enabled only after config validation succeeds
- red window close hides the app to the macOS menu bar instead of quitting
- menu bar has Open, live tunnel status, Start/Stop Tunnel, Quit
- full Quit gracefully stops the managed tunnel, then Agent Host, then exits
- new vector application icon source at `apps/desktop/renderer/src/app-icon.svg`
- IMPORTANT: electron-builder's current macOS icon contract supports `.icns` or `.icon`, not SVG. Before release packaging, convert the SVG source into a proper macOS `.icns` (or `.icon`) asset and point `mac.icon` at that generated asset. Do not ship relying on the current SVG path.
- friend guide rewritten for the UI-first setup flow
- previous DMG is intentionally stale; `dist-share/SHA256SUMS.txt` currently says to regenerate

Official tunnel-client behavior was rechecked:

- `admin tunnels get <tunnel_id>` is the read-only metadata lookup and may use `CONTROL_PLANE_API_KEY` when no admin key is supplied.
- runtime users need Tunnels Read + Use.
- `runtimes connect` is the managed long-lived runtime flow.
- `runtimes status <alias> --json` exposes `process_running`, `healthy`, and `ready`.
- `runtimes stop <alias> --json` is supported and only stops the local runtime.

## Latest verification already completed

Against the current source after tray/log/icon changes:

- `pnpm typecheck` ✅
- `pnpm test` ✅ — core 36/36, agent-host 2/2
- `pnpm lint` ✅
- `pnpm build` ✅

Do not assume packaging is done. The currently existing DMG predates this latest tunnel-control/menu-bar/icon source.

## Task 1 — Review before packaging

Run:

```bash
cd /Users/11397288/DevProjects/gpt-mcp
git status
git diff --check
git diff
```

Confirm no literal API key or unrelated destructive change is present.

Expected relevant working-tree changes include:

- `README.md`
- `apps/desktop/electron/main.ts`
- `apps/desktop/electron/preload.ts`
- `apps/desktop/package.json`
- `apps/desktop/renderer/src/global.d.ts`
- `apps/desktop/renderer/src/main.tsx`
- `apps/desktop/renderer/src/style.css`
- `apps/desktop/renderer/src/app-icon.svg`
- `dist-share/SETUP_FRIEND.md`
- `dist-share/SHA256SUMS.txt`
- `docs/PROJECT_PLAN.md`
- `docs/HANDOFF_PACKAGE_SMOKE.md`

## Task 2 — Ensure only one Codex BEG instance owns port 43123

Before launching a dev/packaged build, fully quit the currently running old Codex BEG instance.

Prefer its UI/menu-bar Quit action when available.

Check:

```bash
lsof -nP -iTCP:43123 -sTCP:LISTEN
```

Do not kill an unknown PID. Do not use `kill -9`.

If an old Codex BEG process remains, identify it first and stop it gracefully.

## Task 3 — Re-run the full verification suite

Run:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
git diff --check
```

All must pass.

## Task 4 — Package the latest app

Run:

```bash
pnpm package
pnpm package:dmg
```

Expected outputs:

```text
apps/desktop/release/mac-arm64/Codex BEG.app
apps/desktop/release/Codex-BEG-0.1.0-mac-arm64.dmg
```

Important packaging acceptance:

- architecture must be arm64
- packaged Agent Host must exist under `Contents/Resources/agent-host/main.js`
- convert `renderer/src/app-icon.svg` into a supported macOS `.icns`/`.icon` asset first, then package with that asset
- the electron-builder log must NOT say `default Electron icon is used`
- app remains unsigned/adhoc because `identity` is intentionally null; do not fake signing or disable Gatekeeper

Verify architecture and bundle metadata:

```bash
file "apps/desktop/release/mac-arm64/Codex BEG.app/Contents/MacOS/Codex BEG"
plutil -p "apps/desktop/release/mac-arm64/Codex BEG.app/Contents/Info.plist" | grep -E 'CFBundleIcon|CFBundleIdentifier|CFBundleName|CFBundleVersion'
```

Verify packaged Agent Host matches the freshly built host:

```bash
shasum -a 256 apps/agent-host/dist/main.js
shasum -a 256 "apps/desktop/release/mac-arm64/Codex BEG.app/Contents/Resources/agent-host/main.js"
```

The two hashes must match.

## Task 5 — Packaged app smoke test

Open the packaged app itself, not source dev mode:

```bash
open "apps/desktop/release/mac-arm64/Codex BEG.app"
```

Verify visually and functionally:

1. New minimal UI renders immediately.
2. New app icon is visible; no Electron default icon.
3. Overview shows live Agent / MCP / Tunnel statuses.
4. Active Project matches the currently selected project and changes immediately when selection changes.
5. Add Project / Add Folder Group updates Projects immediately without changing pages or manually reloading.
6. Activity logs update immediately when Agent/tunnel messages arrive.
7. Connection contains:
   - Tunnel ID input
   - masked Runtime API key input
   - Save & verify
   - Verify again
   - Start tunnel / Stop tunnel
8. With no config, Start is disabled.
9. Closing the red window button hides the app instead of terminating it.
10. Dock icon hides while the window is hidden.
11. Codex BEG remains available as a macOS menu-bar icon.
12. Menu-bar menu contains:
    - Open Codex BEG
    - live Tunnel status
    - Start Tunnel / Stop Tunnel
    - Quit Codex BEG
13. Clicking Open restores the existing window immediately.
14. Agent Host remains healthy while the window is hidden.
15. `curl -fsS http://127.0.0.1:43123/healthz` succeeds while hidden.

## Task 6 — Credential and tunnel smoke

Do NOT retrieve, print, cat, log, or guess the user's real Runtime API key.

The user must paste the real Tunnel ID and Runtime API key into the Connection UI manually if they want the live credential smoke performed.

After the user enters them:

1. Click `Save & verify`.
2. Confirm API-key field stays masked and is cleared from renderer state after save.
3. Confirm validation becomes `Verified` for valid Read access.
4. Confirm the literal key does not appear in Activity logs, terminal process argv, git diff, generated repo files, or error output.
5. Click `Start tunnel`.
6. Wait for live status to reach:

```text
Agent   Running
MCP     Ready
Tunnel  Ready
```

7. Cross-check:

```bash
tunnel-client runtimes status codex-beg --json
```

Require `process_running=true` and readiness/health consistent with the UI before reporting success.

8. Click `Stop tunnel`; confirm status changes immediately and the remote tunnel is not deleted.
9. Start it again.
10. Close the window; verify tunnel stays running and menu-bar status keeps updating.
11. Use menu-bar `Stop Tunnel`, then `Start Tunnel`; verify both work without reopening.
12. Use menu-bar `Quit Codex BEG`; verify the tunnel runtime stops and port 43123 closes cleanly.

If the user does not provide credentials, complete all non-secret smoke checks and report the live credential smoke as the only manual remaining verification.

## Task 7 — DMG smoke

Open/mount the generated DMG and verify it contains the new app with the new icon.

```bash
open apps/desktop/release/Codex-BEG-0.1.0-mac-arm64.dmg
```

Do not weaken Gatekeeper. For an unsigned app, normal right-click Open / Open Anyway is acceptable.

## Task 8 — Distribution copy and checksum

Only after the new DMG passes smoke, copy the newest DMG into `dist-share/` if it is not already there:

```bash
cp "apps/desktop/release/Codex-BEG-0.1.0-mac-arm64.dmg" "dist-share/Codex-BEG-0.1.0-mac-arm64.dmg"
```

Regenerate `dist-share/SHA256SUMS.txt` from the actual new file:

```bash
cd dist-share
shasum -a 256 Codex-BEG-0.1.0-mac-arm64.dmg > SHA256SUMS.txt
cd ..
```

Do not retain the stale previous hash.

## Task 9 — Update project plan after successful smoke

Update `docs/PROJECT_PLAN.md` only after the new package has actually passed.

Change the distribution checkpoint from repackage-required to ready, and record:

- new DMG SHA-256
- new packaged Agent Host SHA-256
- app icon successfully packaged
- packaged tray/hide smoke result
- Connection Save/Verify/Start/Stop smoke result, or explicitly state live credential smoke remains manual if the user did not provide credentials

## Final verification

Run again:

```bash
git diff --check
git status
git diff
```

Do not commit or push.

Final report must include:

1. package command results
2. arm64 verification
3. icon verification
4. packaged Agent Host hash comparison
5. app/Agent/MCP status smoke
6. immediate Projects render smoke
7. Activity realtime smoke
8. menu-bar hide/reopen smoke
9. Save & verify result
10. Start/Stop tunnel result
11. Quit cleanup result
12. final DMG path
13. final DMG SHA-256
14. final `git status`
15. confirmation no secret was printed or committed
16. confirmation no destructive Git cleanup, commit, or push occurred

## Completion record — 2026-08-26

The non-secret package smoke was completed against the packaged app, not dev mode.

- `pnpm typecheck` ✅
- `pnpm test` ✅ — core 36/36, agent-host 2/2; the first sandboxed attempt was blocked by loopback `EPERM` and was rerun with loopback permission
- `pnpm lint` ✅
- `pnpm build` ✅
- `pnpm package` ✅
- `pnpm package:dmg` ✅
- `git diff --check` ✅
- arm64 verified with `file`: `Codex BEG` is a Mach-O arm64 executable
- bundle metadata verified: `com.codexbeg.desktop`, version `0.1.0`, `CFBundleIconFile=icon.icns`
- packaged icon verified at `Contents/Resources/icon.icns`; electron-builder did not report the default Electron icon
- packaged Agent Host exists at `Contents/Resources/agent-host/main.js`
- source/packaged Agent Host SHA-256: `4a20eb09ef3fadb5b6ffe6ee789574a8b6af12bd03694aaa2d63351e6c54465d`
- packaged app `/healthz` ✅ — version `0.1.0`, 35 tools, catalog hash `67325d2e949dde8a`
- visual window smoke ✅ — Overview rendered with Overview/Projects/Activity/Connection/Diagnostics navigation and the new Codex BEG icon
- close/reopen smoke ✅ — closing the window left port `43123` and Agent Host healthy; reopening the packaged app restored the window
- graceful Quit smoke ✅ — port `43123` closed after quitting the packaged app
- DMG read-only mount ✅ — contained `Codex BEG.app` and `Contents/Resources/icon.icns`
- final DMG: `apps/desktop/release/Codex-BEG-0.1.0-mac-arm64.dmg`
- final DMG SHA-256: `617c38dc6344e7c63e1bc9ccd42392f503878c35370eece0cd183b3fccadde2d`
- distribution copy: `dist-share/Codex-BEG-0.1.0-mac-arm64.dmg`; checksum regenerated in `dist-share/SHA256SUMS.txt`

The live credentialed tunnel smoke was intentionally not run: no Runtime API key was supplied, and no key was printed, logged, committed, or written to the repository. Connection Save/Verify/Start/Stop and external ChatGPT connector verification remain manual after the operator supplies credentials.

The app remains an unsigned/adhoc development distribution. This package checkpoint is ready for the public GitHub Release step; it is not yet a Homebrew-installable release.
