# Codex BEG for macOS — friend setup

Codex BEG is a self-contained **macOS Apple Silicon (arm64)** desktop app. A normal user does not need this source repository, Node.js, npm, pnpm, TypeScript, or Codex CLI.

The app starts its local Agent Host automatically and can configure, verify, start, stop, and monitor an installed OpenAI `tunnel-client` runtime from the UI.

## 1. Requirements

- Apple Silicon Mac (`arm64`).
- ChatGPT workspace access that allows developer apps/connectors.
- Access to the OpenAI Platform organization that owns the tunnel.
- An existing Tunnel ID.
- A separate **Runtime API key** whose principal has Tunnels **Read + Use** for that tunnel.
- `tunnel-client` installed on the Mac.

The two values are different:

```text
Tunnel ID       tunnel_0123456789abcdef0123456789abcdef
Runtime API key <secret>
```

Useful official pages:

- Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- Tunnels: https://platform.openai.com/settings/organization/tunnels
- Runtime API keys: https://platform.openai.com/settings/organization/api-keys
- tunnel-client releases: https://github.com/openai/tunnel-client/releases/latest
- ChatGPT connectors: https://chatgpt.com/#settings/Connectors

## 2. Install Codex BEG

1. Open `Codex-BEG-0.1.0-mac-arm64.dmg`.
2. Drag `Codex BEG.app` to Applications.
3. Open it from Finder.

This development distribution is not Developer ID notarized. If macOS blocks it, right-click **Codex BEG.app → Open**. If needed, use **System Settings → Privacy & Security → Open Anyway**. Do not disable Gatekeeper globally.

Closing the Codex BEG window does **not** quit the app. It hides to the macOS menu bar so the local agent and tunnel can continue running. Click the menu-bar icon to reopen the window. Use **Quit Codex BEG** from that menu to stop the tunnel and exit fully.

## 3. Install tunnel-client

If Homebrew is installed:

```bash
brew install openai/tools/tunnel-client
tunnel-client --version
```

Otherwise download the macOS arm64 binary from Platform Tunnels or the official `openai/tunnel-client` release page and put it on the user's PATH, for example `~/bin/tunnel-client`.

Codex BEG does not bundle `tunnel-client`; it detects and controls the installed binary.

## 4. Get the Tunnel ID

Open Platform Tunnels, select the tunnel for this Mac, and copy its `tunnel_id`.

It must look like:

```text
tunnel_0123456789abcdef0123456789abcdef
```

The value is `tunnel_` plus 32 lowercase hexadecimal characters.

## 5. Get a Runtime API key

Create or request a **Restricted Runtime API key** with:

- Tunnels: **Read**
- Tunnels: **Use**

Do not use `OPENAI_ADMIN_KEY` for the long-lived runtime. Admin keys are for tunnel CRUD and are a separate, higher-privilege credential.

Prefer a separate restricted key per person/device when the organization's policy permits it.

## 6. Configure Codex BEG

1. Open **Codex BEG → Connection**.
2. Paste the Tunnel ID.
3. Paste the Runtime API key into the password field.
4. Click **Save & verify**.

The API-key field is masked. Codex BEG never returns the saved key to the renderer after it is stored. The saved key is encrypted using Electron `safeStorage` backed by the operating system; the app refuses to save it if secure storage is unavailable.

**Save & verify** performs a read-only lookup of the exact Tunnel ID with the saved runtime credential. A successful result means the key can read that tunnel. Starting the runtime is the final check for Tunnels **Use** and end-to-end readiness.

Expected UI after verification:

```text
Configuration: Verified
Tunnel:        Stopped
```

If verification fails, Codex BEG shows the error immediately. Fix the Tunnel ID, key, or Tunnels Read permission and save again.

## 7. Start the tunnel

Make sure the top status shows:

```text
Agent  Running
MCP    Ready
```

Then click **Start tunnel** in Overview or Connection.

Codex BEG uses the supported managed-runtime flow equivalent to:

```bash
tunnel-client runtimes connect \
  --alias codex-beg \
  --tunnel-id <TUNNEL_ID> \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-server-url http://127.0.0.1:43123/mcp
```

The literal key is supplied through the child process environment, not placed in the command-line argument list or generated profile.

Only treat the connection as fully ready when the UI shows:

```text
Agent   Running
MCP     Ready
Tunnel  Ready
```

The status updates automatically; no page reload or page switching is required.

If the saved key has Tunnels Read but lacks Tunnels Use, verification can succeed while Start fails. Codex BEG reports that separately.

## 8. Stop, hide, reopen, and quit

From the window:

- **Stop tunnel** stops only the managed local runtime; it does not delete the remote tunnel.
- Closing the red window button hides Codex BEG to the menu bar and leaves the current runtime running.

From the menu-bar icon:

- **Open Codex BEG** — show the window.
- **Tunnel: ...** — current live tunnel status.
- **Start Tunnel / Stop Tunnel** — control the runtime without reopening the window.
- **Quit Codex BEG** — gracefully stop the tunnel, stop the local Agent Host, and exit the app.

## 9. Optional terminal diagnostics

The app is the normal control surface, but these commands are useful for troubleshooting:

```bash
tunnel-client runtimes status codex-beg --json
curl -fsS http://127.0.0.1:43123/healthz
```

A healthy managed runtime reports explicit fields including `process_running`, `healthy`, and `ready`.

If a local tunnel-client health UI URL is reported, its `/healthz` is liveness and `/readyz` is the important readiness probe.

## 10. Connect ChatGPT

With Codex BEG showing **Tunnel Ready**:

1. Open ChatGPT connector/app settings.
2. Create or edit the developer app/connector.
3. Choose **Connection: Tunnel**.
4. Select the tunnel or paste the same Tunnel ID.
5. Scan tools / refresh the connector catalog.
6. Open a new chat with the Codex BEG connector selected.

The tunnel must be associated with the target ChatGPT workspace and the connector operator needs the required tunnel access.

## 11. First tool test

Start read-only:

1. Confirm **Agent Running**, **MCP Ready**, **Tunnel Ready**.
2. Ask ChatGPT to call `workspace_list`.
3. Confirm a read-only result.
4. Add/select a project in the **Projects** page.
5. Confirm **Overview → Active project** updates immediately.

Workspace expansion through MCP remains approval-gated where required.

## 12. Projects and live activity

The Projects page supports:

- Add project.
- Add folder group / machine root.
- Register child projects below a folder group.
- Select the active/default project.
- Remove only a registration; project files are not deleted.

Project changes refresh immediately and are also reconciled periodically so changes made through MCP appear without reloading the UI.

The Activity page updates Agent/tunnel logs through Electron IPC immediately. Approval, operation, and recovery views refresh continuously and refresh immediately after user actions.

## 13. Troubleshooting

### Tunnel says `Not installed`

```bash
command -v tunnel-client
tunnel-client --version
```

If it is installed outside normal PATH locations, launch Codex BEG with `TUNNEL_CLIENT_BIN` pointing to the full executable path.

### Configuration says `Invalid`

Check:

- Tunnel ID format.
- Runtime API key is from Runtime API keys, not an unrelated key.
- The key principal has Tunnels Read.
- The key can access the exact target tunnel.

### Verify succeeds but Start fails with 401/403

The key can read tunnel metadata but probably lacks Tunnels Use. Grant Tunnels **Read + Use**, then click **Verify again** and **Start tunnel**.

### Agent or MCP is offline

Open **Diagnostics → Run checks**. If needed use **Restart local agent**.

Terminal checks:

```bash
curl -i --max-time 3 http://127.0.0.1:43123/healthz
lsof -nP -iTCP:43123 -sTCP:LISTEN
```

Do not kill an unknown PID. Do not run two Codex BEG instances intentionally.

### ChatGPT shows an old tool catalog

1. **Diagnostics → Restart local agent**.
2. Wait for Agent Running / MCP Ready.
3. Make sure Tunnel returns to Ready.
4. Refresh/reconnect the ChatGPT connector and scan tools again.

### Calls stop after sleep/reboot

Open Codex BEG. It automatically starts the local Agent Host and restores the saved encrypted tunnel configuration. Verify the configuration status, then click **Start tunnel** if the managed runtime is stopped.

## 14. Security notes

- Never paste the Runtime API key into chat, tickets, screenshots, or documentation.
- Codex BEG stores the runtime key encrypted via OS-backed Electron `safeStorage`; it does not store the literal key in the repository or pass it as a command-line value.
- The app does not need or store `OPENAI_ADMIN_KEY` for normal runtime use.
- The local MCP server remains on loopback at `127.0.0.1:43123`.
- The per-session Agent Host admin token is generated internally and is not user-configured.
- No raw shell or generic delete MCP tool is exposed.

## 15. Uninstall

1. Choose **Quit Codex BEG** from the menu-bar icon so the managed runtime and Agent Host stop cleanly.
2. Move `Codex BEG.app` to Trash.
3. Removing the app does not delete registered project folders or the remote OpenAI tunnel.

If you also want to remove Codex BEG's local app data/credential state, do that separately and intentionally; do not remove project directories.
