# sshshot

**Take a screenshot locally → it auto-uploads via SSH → the remote file path lands on your clipboard.** Built for pasting screenshots into Claude Code, OpenAI Codex, or any other AI agent running over SSH on a remote box, where you can't drag-and-drop images. macOS, Linux (X11), Windows, WSL.

```bash
npm install -g @flamerged/sshshot
```

> Fork of [HendrikYtt/clipshot](https://github.com/HendrikYtt/clipshot) with macOS support added (cherry-picked from upstream PR #1, with both Codex-flagged P1 bugs fixed) and modern dev tooling (Yarn 4, ESLint 9, Husky, lint-staged, branch protection). Original credit and license preserved.

![Demo](demo.gif)

## The problem

You SSH'd into a remote dev box to use Claude Code, Codex, Aider, or any other CLI AI agent. You want to ask it about a screenshot. But you **can't paste an image into a remote terminal** — there's no drag-and-drop, no clipboard sharing, and uploading via `scp` then typing the path manually breaks your flow.

## The fix

sshshot runs as a tiny background daemon on your local machine. The moment you take a screenshot:

1. **Locally** — sshshot detects the new screenshot (clipboard or screenshot folder).
2. **Uploads it** — pipes the image bytes through SSH to `~/sshshot-screenshots/screenshot-<timestamp>.png` on your remote.
3. **Pastes back** — replaces your clipboard with the **remote absolute path** to that file.
4. **You paste** the path into Claude Code / Codex / wherever — the AI's tool layer reads the file and sees your screenshot.

No manual `scp`. No typing paths. Just `Cmd+Shift+4`, then `Cmd+V` into your AI prompt.

## Quick start

```bash
# install globally
npm install -g @flamerged/sshshot

# first run — interactive setup, auto-detects your ~/.ssh/config and shell history
sshshot

# later
sshshot start    # start daemon (pick a remote)
sshshot stop     # stop daemon
sshshot status   # is it running, and against which remote
sshshot config   # change remotes
```

## Per-OS setup

### macOS

Two screenshot flows are supported:

- **Cmd+Shift+3 / 4 / 5** — saves a `.png` file to your Desktop (or wherever `defaults read com.apple.screencapture location` points). **Zero dependencies.** This is what most people use.
- **Cmd+Ctrl+Shift+3 / 4 / 5** — image goes straight to clipboard, no file. Requires [`pngpaste`](https://github.com/jcsalterego/pngpaste):

  ```bash
  brew install pngpaste
  ```

If `pngpaste` isn't installed, the daemon logs a warning and falls back silently to the file-watcher path.

### Linux

X11 only. Needs `xclip`:

```bash
sudo apt install xclip   # Debian/Ubuntu
sudo dnf install xclip   # Fedora
sudo pacman -S xclip     # Arch
```

Wayland support is on the [Roadmap](#roadmap).

### Windows / WSL

Works out of the box — uses PowerShell's `System.Windows.Forms.Clipboard`. WSL is auto-detected via `/proc/version`.

## Use cases

- **Claude Code over SSH** — paste the path; Claude reads the file via its `Read` tool.
- **OpenAI Codex CLI** — same flow; Codex reads files referenced in prompts.
- **Aider, Continue, any AI agent that can read local files on the remote** — works.
- **Plain ssh sessions where you want to ship a screenshot to a teammate's box** — also works; you just paste the path into a chat.

## Features

- Auto-detects SSH remotes from `~/.ssh/config` (does **not** scan shell history — by design, see Security)
- **Local mode** for when you don't need a remote — saves to `~/sshshot-screenshots/`, copies the local path
- **Remote mode** uploads via your existing SSH config (ControlMaster connection reuse honored if you've set it)
- Per-source MD5 deduping — Mac file-saved and clipboard screenshots can't collide and re-upload each other (a real bug Codex caught in upstream PR #1)
- Background daemon — start once, take screenshots all day
- WSL support (reads Windows clipboard from inside Linux)

## Commands

```
sshshot              first-time setup, then start the daemon
sshshot start        start daemon (prompts for which remote)
sshshot stop         stop the running daemon
sshshot status       show running PID + target remote
sshshot config       add/remove SSH remotes
sshshot uninstall    stop daemon + remove ~/.config/sshshot
```

Logs land in `~/.config/sshshot/logs/sshshot-<timestamp>.log` (rotated hourly).

## How it works (technical)

- TypeScript CLI. Single binary entry (`dist/index.js`) that double-purposes as both the foreground configurator and the daemon (when invoked with `--daemon <remote>`).
- Background daemon spawned via `nohup` (Unix) or `spawn(..., {detached: true})` (Windows) so closing your terminal doesn't kill it.
- 200 ms poll loop reads the clipboard and (on macOS) the screenshot folder, MD5-hashes new bytes, dedupes per source, then uploads.
- Upload mechanic: `ssh <remote> 'mkdir -p ~/sshshot-screenshots && cat > ~/sshshot-screenshots/<filename>'` with the image piped to stdin. No temp files, no `scp`.
- All OS-specific work is shell-outs (`xclip`, `pbcopy` / `pngpaste`, PowerShell `Clipboard.GetImage()`). No native modules, no Electron, no large runtime cost — the daemon idles around 30–80 MB resident.

## FAQ

**Does this need any privileges? Sudo? Mac Screen Recording permission?**
No. sshshot doesn't capture the screen — it forwards screenshots **you** took with your OS's built-in keystrokes. macOS `pbcopy` / `pngpaste` and reading `~/Desktop` don't require TCC entitlements.

**Will Claude Code / Codex actually see my screenshot, or just receive a string?**
They receive the path as a string. Both tools (and most AI agents) are happy to call their built-in file-read on a `.png` you reference, decode the image, and use it as input. You don't have to do anything — just paste the path in your prompt and ask your question.

**What about Cmd+Shift+5's video capture / screen recording feature?**
sshshot only ships screenshot images (`.png`), not screen recordings (`.mov`). Recordings are out of scope.

**Does this expose my screenshots to anyone else?**
Only to the remote you select. Transport is plain SSH, so authentication and encryption are whatever your `~/.ssh/config` already provides. The screenshot is uploaded under your remote user's home directory.

**Why not use ShareX / Flameshot / Maccy / etc.?**
Those tools either capture and host externally (privacy: your screenshot lives on a 3rd-party server) or are clipboard managers without an SSH-paste path. sshshot's whole point is **the remote box you already use becomes the destination**.

**Why not a browser extension?**
You'd still need a server to receive uploads, and AI agents running over SSH don't see your browser's clipboard. SSH-side delivery cuts out the middleman.

## Roadmap

- [ ] Linux Wayland clipboard support (`wl-clipboard`)
- [ ] Replace 200 ms polling with `fs.watch` / `chokidar` for the macOS screenshot folder
- [ ] Localized macOS screenshot filename matching (currently English-only `Screenshot*.png`; missing Bildschirmfoto, Capture d'écran, etc.)
- [ ] macOS demo gif (currently shows the upstream Linux demo)
- [ ] Test suite (Vitest)
- [ ] Optional inline image paste (instead of path) for tools that accept multipart pastes — out of scope today, future ergonomic win
- [ ] Migrate `execSync` shell calls to `spawnSync` with array args — eliminates remaining shell-injection surface (`getRemoteHomePath`'s `ssh -G ${remote}` etc.)
- [ ] File Socket.dev false-positive review request once Supply Chain score plateaus

## Security

sshshot is intentionally narrow about what it touches:

- **Reads `~/.ssh/config`** — to enumerate hostnames you've already configured. Required for the auto-detect prompt during setup.
- **Reads/writes the clipboard** — the whole point.
- **Reads the macOS screenshot folder** (file-watcher mode) and clipboard via `pngpaste` — to capture the image you just took.
- **Pipes the image to a remote you selected via `ssh user@host`** — the upload mechanic.

What sshshot **does not** do, by deliberate design:

- **Does not read your shell history** (`~/.bash_history`, `~/.zsh_history`). Reading shell history is the #1 behavioral signal of credential-stealing malware (info-stealers do exactly that to find AWS/SSH credentials), and Socket.dev's AI scanner correctly flags packages that do it. Earlier upstream versions scanned history; this fork removed it. Users without `~/.ssh/config` entries can add hosts manually via the setup prompt.
- **Does not capture the screen.** The OS captures; sshshot only forwards what you produced via Cmd+Shift / Cmd+Ctrl+Shift / Print Screen.
- **Does not phone home.** No telemetry, analytics, or auto-update checks.
- **Does not require root, sudo, or any TCC entitlement.**

## Contributing

PRs welcome. The repo enforces:

- `master` is protected — CI must pass, conversation must resolve, signed commits required.
- Squash-merge only (single commit lands on `master` per PR).
- Pre-commit hook runs Prettier and ESLint on staged files via `lint-staged`.

```bash
# clone and set up
git clone https://github.com/flamerged/sshshot.git
cd sshshot
corepack enable           # activates the pinned Yarn 4
yarn install              # generates yarn.lock the first time
yarn build                # tsc → dist/
yarn typecheck            # tsc --noEmit
yarn lint                 # eslint
yarn format               # prettier --write
```

## Acknowledgements

Built on [clipshot](https://github.com/HendrikYtt/clipshot) by Hendrik Ytt. macOS support originally proposed in [clipshot#1](https://github.com/HendrikYtt/clipshot/pull/1) by amoghbanta — the architecture (concurrent clipboard via `pngpaste` + screenshot-folder file watcher) is theirs; sshshot fixed two P1 bugs flagged in OpenAI Codex's review of that PR.

## License

[MIT](./LICENSE) — original copyright Hendrik Ytt, fork copyright Mersad Ajanovic.
