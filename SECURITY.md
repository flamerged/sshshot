# Security policy

## Reporting a vulnerability

If you've found a security issue, please **don't open a public GitHub issue**. Email the maintainer directly via the email associated with the npm package, or open a [GitHub Security Advisory](https://github.com/flamerged/sshshot/security/advisories/new) for private disclosure. Expect a response within 7 days.

## What this package does (and why)

sshshot is a CLI utility that ships local screenshots to a remote SSH host. By design, it touches several capabilities that **automated security scanners (Socket.dev, Snyk, etc.) flag as malware-adjacent** because they overlap with the behavioral patterns of credential-stealing malware. Each is intentional and documented below.

### Capability inventory

| Capability                                                                                     | Why sshshot needs it                                                          | Malware also does this?                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| **Reads clipboard image** (`xclip`, `pbcopy`/`pngpaste`, `Clipboard.GetImage`)                 | Detects screenshots the user just took                                        | Yes — clipboard stealers do too              |
| **Reads `~/.ssh/config`**                                                                      | Auto-detect remote hosts during interactive setup                             | Yes — info-stealers enumerate SSH targets    |
| **Reads macOS screenshot folder** (path from `defaults read com.apple.screencapture location`) | Detects Cmd+Shift+3/4/5 file-saved screenshots                                | Less common in malware                       |
| **Spawns a detached background daemon** (`spawn(..., {detached: true})` on all platforms)      | Tool runs continuously without holding the terminal                           | Yes — persistence malware uses this          |
| **Pipes bytes via `ssh <user@host> 'cat > path'`**                                             | Upload mechanic — no temp files, no scp                                       | Yes — exfiltration malware uses this         |
| **Writes to clipboard** (`xclip -i`, `pbcopy`, `Set-Clipboard`)                                | Pastes the remote path back so the user can paste into their AI prompt        | Yes                                          |
| **Hidden PowerShell on Windows** (`windowsHide: true`)                                         | Prevents a console window from flashing every 200 ms during clipboard polling | Yes — but here it's pure UX, not concealment |
| **Persists logs** (`~/.config/sshshot/logs/`)                                                  | Operational diagnostics                                                       | Routine for any background tool              |
| **Persists local screenshot copies** (`~/sshshot-screenshots/`)                                | Required only in `local` mode (no remote upload)                              | Less common in malware                       |

### What this package does NOT do, by deliberate design

- **Does not read shell history** (`~/.bash_history`, `~/.zsh_history`) — the strongest info-stealer signal. Earlier upstream versions did; this fork removed that path entirely. Users without `~/.ssh/config` entries can add hosts manually via the interactive setup prompt.
- **Does not capture the screen** — sshshot only forwards screenshots **the user** took with the OS's built-in keystrokes. macOS Screen Recording / TCC permissions are not requested.
- **Does not phone home** — no telemetry, analytics, error reporting, or auto-update checks.
- **Does not request root, sudo, or any TCC entitlement.**
- **Does not exfiltrate to anywhere the user did not configure.** The remote target comes from interactive selection out of the user's own `~/.ssh/config`. There is no hard-coded server, no fallback host, no opt-out telemetry endpoint.

## Build supply chain

- Released via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no long-lived `NPM_TOKEN` is ever stored. Each release is signed with a [Sigstore provenance attestation](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-publish.md#provenance) tying the published tarball to a specific commit in this repo's GitHub Actions run. The "Verified provenance" badge on the npm page is the visual confirmation.
- Branch protection on `master`: required CI status check, signed commits, conversation resolution, 1 review, squash-merge only, no force pushes, no branch deletion.
- Pre-commit hooks (Husky + lint-staged) enforce ESLint + Prettier on every commit; commit-msg hook enforces Conventional Commits via commitlint.
- `npm audit` is clean as of last release. Direct dependency tree is intentionally tiny — only one runtime dependency (`enquirer` for interactive prompts) and that's only loaded during one-shot setup, not by the daemon.

## False-positive reviews from automated scanners

If a security scanner has flagged sshshot as malware/spyware:

- **Socket.dev**: filed a [false-positive review request](https://socket.dev) — link the result of that review here once available.
- **Snyk / GitHub CodeQL**: this package's behavior matches several malware signatures (clipboard read + ssh upload + background daemon). The signatures are correct in pattern; the _intent_ is what differs. Provenance + this document are the artifacts that distinguish.

If you're an operator evaluating whether to install sshshot in your environment and the above doesn't address your concern, open a discussion on the repo and we'll talk through the specific risk you're worried about.
