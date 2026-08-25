# Codex Handoff — GitHub Release + Homebrew Cask

Continue in:

`/Users/11397288/DevProjects/gpt-mcp`

Do not discard existing work. Do not run `git reset`, `git clean`, `git restore`, or destructive cleanup. Do not print or commit Runtime API keys, Apple signing secrets, certificates, app-specific passwords, GitHub PATs, or other credentials.

This handoff extends `docs/HANDOFF_PACKAGE_SMOKE.md`. Finish the package/smoke requirements first, then prepare public distribution.

## Completion record — 2026-08-26

This handoff is complete for the first public arm64 release.

- GitHub repository: `https://github.com/newchille/codex-beg`
- Release tag: `v0.1.0`
- GitHub Actions run: `32886398173` ([run](https://github.com/newchille/codex-beg/actions/runs/32886398173))
- Release: [v0.1.0](https://github.com/newchille/codex-beg/releases/tag/v0.1.0)
- Published assets: `Codex-BEG-0.1.0-mac-arm64.dmg`, `SHA256SUMS.txt`
- Published DMG SHA-256: `921e0d5aac77b09cb1630d8244e6195f0df1c9951db46aef5cb9a8698c124afc`
- Release commit: `b33a16f` (`Prepare Codex BEG v0.1.0 release`)

The release workflow is `.github/workflows/release.yml`. The tagged workflow passed `pnpm typecheck`, `pnpm test` (38/38), `pnpm lint`, `pnpm build`, icon generation, arm64 packaging, bundle checks, Agent Host hash checks, and SHA-256 asset generation. The release is intentionally unsigned/adhoc: no Developer ID signing or notarization credentials were available, so the workflow does not claim Gatekeeper approval. macOS may require the normal first-launch Open Anyway confirmation; users must not disable Gatekeeper globally.

The public third-party tap is `https://github.com/newchille/homebrew-tap`, with cask `Casks/codex-beg.rb`. The tested install path is:

```bash
brew install openai/tools/tunnel-client
brew install --cask newchille/tap/codex-beg
open -a "Codex BEG"
```

`tunnel-client` remains an external prerequisite and is not bundled. The cask uses the versioned release URL, the exact published SHA-256, `depends_on arch: :arm64`, and `depends_on macos: :big_sur`.

Homebrew validation completed against the live release:

- `brew install --cask newchille/tap/codex-beg`: passed.
- `brew uninstall --cask codex-beg`: passed.
- reinstall from the public tap: passed; final bundle is `/Applications/Codex BEG.app`.
- installed-app launch smoke: passed after the standard first-launch confirmation for the unsigned app; exact executable was `/Applications/Codex BEG.app/Contents/MacOS/Codex BEG` and `/healthz` returned version `0.1.0`, 35 tools, and catalog hash `67325d2e949dde8a`.
- `brew audit --new --cask newchille/tap/codex-beg`: no cask syntax/dependency errors remain. Homebrew still reports the expected policy findings for this new unsigned public project: signature verification fails for the adhoc build and the repository is not yet notable by Homebrew's stars/watchers/forks thresholds.
- `brew upgrade --cask newchille/tap/codex-beg`: not run because no later version exists.

No Runtime API key, Apple credential, certificate, GitHub PAT, or other secret was printed or committed. The local source tree was not cleaned after the release/install path became ready; the final Homebrew-installed app remains in place for the next operator action.

## Important icon correction before release

`apps/desktop/renderer/src/app-icon.svg` is the vector source of the new icon.

Current electron-builder macOS documentation supports `.icns` or `.icon` for `mac.icon`; do not rely on SVG directly for the final macOS package.

Before packaging the release:

1. convert the SVG source to a proper macOS `.icns` or `.icon` asset using a deterministic build step
2. update `apps/desktop/package.json` so `mac.icon` points to that supported asset
3. package again
4. verify electron-builder does not report `default Electron icon is used`
5. verify the packaged app shows the new icon in Finder/Dock/DMG

## Distribution architecture

Use:

```text
Git tag vX.Y.Z
      ↓
GitHub Actions
      ↓
typecheck / test / lint / build
      ↓
macOS arm64 package
      ↓
Developer ID sign + notarize when credentials exist
      ↓
GitHub Release
      ↓
versioned DMG + SHA256SUMS
      ↓
Homebrew tap Cask update
      ↓
user: brew install --cask <owner>/tap/codex-beg
```

Codex BEG is a native macOS GUI `.app`, so Homebrew distribution must be a **Cask**, not a formula.

## Task 1 — Prepare GitHub Actions release workflow

Create a release workflow triggered only by semantic version tags, for example:

```text
v0.1.0
v0.2.0
v1.0.0
```

The workflow must:

1. checkout the repository
2. install the Node version supported by this repository
3. enable/install the pinned `pnpm@11.19.0`
4. install dependencies from the lockfile
5. run:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

6. create the supported macOS icon asset from `app-icon.svg`
7. package macOS arm64
8. sign and notarize if legitimate Apple Developer credentials are configured
9. verify signing/notarization before public release
10. calculate SHA-256 for the DMG
11. create/update the GitHub Release matching the tag
12. upload the versioned DMG and SHA256SUMS as immutable release assets

Use GitHub Actions secrets for Apple/GitHub credentials. Never commit secrets.

Prefer the repository-provided `GITHUB_TOKEN` for same-repository release upload when sufficient.

## Task 2 — Signing and notarization

For public distribution, strongly prefer Apple Developer ID signing + notarization.

Do not disable Gatekeeper or fake signing.

When Apple credentials are available, configure electron-builder/GitHub Actions using legitimate Developer ID Application credentials and notarization authentication, then verify:

```bash
codesign --verify --deep --strict --verbose=2 "Codex BEG.app"
spctl --assess --verbose --type exec "Codex BEG.app"
xcrun stapler validate "Codex BEG.app"
```

If Apple signing credentials are not available yet, prepare the workflow/tap but clearly label the release as unsigned development software. Do not call it a frictionless public release.

## Task 3 — GitHub Release asset naming

Use immutable, versioned assets such as:

```text
Codex-BEG-0.1.0-mac-arm64.dmg
SHA256SUMS.txt
```

Do not replace an existing tagged release asset in place with different bytes. Publish a new version instead.

The Homebrew Cask must point to the versioned GitHub Release URL and exact SHA-256.

## Task 4 — Create Homebrew tap repository

Preferred repository under the same GitHub owner/org:

```text
homebrew-tap
```

Cask path:

```text
Casks/codex-beg.rb
```

Resolve the real GitHub owner and main repository name before publishing. Do not leave placeholders in a live tap.

Initial target install command:

```bash
brew install --cask <GITHUB_OWNER>/tap/codex-beg
```

A fully-qualified cask install should automatically tap the repository; users should not need a separate `brew tap` command for the normal install path.

## Task 5 — Cask definition

Create a cask equivalent to:

```ruby
cask "codex-beg" do
  version "0.1.0"
  sha256 "<ACTUAL_RELEASE_DMG_SHA256>"

  url "https://github.com/<GITHUB_OWNER>/<GITHUB_REPO>/releases/download/v#{version}/Codex-BEG-#{version}-mac-arm64.dmg"
  name "Codex BEG"
  desc "Local workspace agent with Secure MCP Tunnel control"
  homepage "https://github.com/<GITHUB_OWNER>/<GITHUB_REPO>"

  depends_on arch: :arm64

  app "Codex BEG.app"
end
```

Use the actual stable version and exact release hash.

Do not use `sha256 :no_check` for a versioned stable DMG.

## Task 6 — tunnel-client prerequisite

Codex BEG detects and controls the official external `tunnel-client`; it does not bundle it.

Decide and test the cleanest Homebrew UX before publishing:

Option A — document two installs:

```bash
brew install openai/tools/tunnel-client
brew install --cask <GITHUB_OWNER>/tap/codex-beg
```

Option B — if current Homebrew Cask dependency semantics cleanly support the official tunnel-client formula/tap, declare it as a dependency and prove a fresh-machine `brew install --cask ...` installs everything correctly.

Do not invent or vendor a tunnel-client binary just to make the Cask one-command.

## Task 7 — Validate Homebrew installation

On a clean/test Mac or clean Homebrew state, validate at minimum:

```bash
brew install --cask <GITHUB_OWNER>/tap/codex-beg
brew audit --new --cask <GITHUB_OWNER>/tap/codex-beg
brew uninstall --cask <GITHUB_OWNER>/tap/codex-beg
```

Then reinstall and smoke the actual installed app:

- app launches
- Agent Host starts
- menu-bar behavior works
- Connection config works
- Start/Stop Tunnel works after user-provided credentials
- no source repository/Node/pnpm is required at runtime

After publishing a later test version, verify:

```bash
brew upgrade --cask <GITHUB_OWNER>/tap/codex-beg
```

## Task 8 — Automate Homebrew Cask updates

After a successful GitHub Release and known DMG SHA-256, update:

```text
homebrew-tap/Casks/codex-beg.rb
```

with the new `version` and `sha256`.

Automate this from the release workflow where practical.

For cross-repository writes, use a narrowly scoped GitHub App or PAT only if the normal `GITHUB_TOKEN` cannot update the tap repository. Keep it in GitHub Actions secrets with minimum permissions.

Never store a broad personal token in source.

## Task 9 — Official Homebrew later, not required now

The initial supported distribution should be the project's own third-party tap.

Do not submit to official `homebrew/cask` until the project satisfies current Homebrew acceptance/notability requirements and the release works with macOS security protections enabled.

If later accepted into official Homebrew Cask, the desired install command becomes:

```bash
brew install --cask codex-beg
```

## Task 10 — Release documentation

Update README so end users see the simple path first.

Desired order:

```text
Install tunnel-client prerequisite if needed
brew install --cask <owner>/tap/codex-beg
Open Codex BEG
Connection → Tunnel ID + Runtime API key
Save & verify
Start Tunnel
```

Document upgrades:

```bash
brew update
brew upgrade --cask <owner>/tap/codex-beg
```

Document uninstall:

```bash
brew uninstall --cask <owner>/tap/codex-beg
```

Do not tell users to disable Gatekeeper.

## Publish boundary

The user wants GitHub Release + Homebrew distribution, but before the first actual public push/release confirm:

- actual GitHub owner/org
- main repository name
- whether it should be public or private
- tap repository name/location
- Apple signing/notarization credential availability

Do not publish to an assumed account/repository.

## Final report

Report:

1. release workflow path
2. release tag/version used
3. typecheck/test/lint/build results
4. signing/notarization result
5. final GitHub Release asset names
6. DMG SHA-256
7. Homebrew tap repository
8. cask path
9. exact install command
10. tunnel-client prerequisite strategy
11. `brew audit` result
12. install/uninstall/upgrade smoke results
13. confirmation no secrets were committed or printed
14. final git status
15. any remaining action requiring the user's GitHub/Apple credentials
