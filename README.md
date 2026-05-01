# sshshot

Screenshot relay for SSH workflows. Take a screenshot locally, sshshot auto-uploads it to your remote box and pastes the remote path back to your clipboard. macOS, Linux (X11), Windows, WSL.

> Fork of [HendrikYtt/clipshot](https://github.com/HendrikYtt/clipshot) with macOS support added (cherry-picked from upstream PR #1, with bug fixes) and a few quality-of-life improvements. Original credit and license preserved.

![Demo](demo.gif)

## Why?

When using AI CLI tools like Claude Code, Codex, or others, you often need to share screenshots with them. But when you SSH into a remote server to use these tools, you can't paste images at all.

sshshot solves this — take a screenshot locally, and it automatically uploads to your remote server and copies the remote path to your clipboard. So you screenshot like usual, paste the path, and the AI reads the image.

## Install

```bash
npm install -g @flamerged/sshshot
```

### macOS — optional clipboard-screenshot support

sshshot supports both Mac screenshot flows out of the box:

- **Cmd+Shift+3 / 4 / 5** (saves a `.png` file to your Desktop or wherever `defaults read com.apple.screencapture location` points) — works with **zero dependencies**.
- **Cmd+Ctrl+Shift+3 / 4 / 5** (puts the image directly on the clipboard, no file) — requires [`pngpaste`](https://github.com/jcsalterego/pngpaste):

  ```bash
  brew install pngpaste
  ```

If you only ever use the file-saving shortcuts, you can skip `pngpaste` entirely.

### Linux

X11 only — needs `xclip`. Wayland support is planned (see Roadmap).

```bash
sudo apt install xclip   # Debian/Ubuntu
sudo dnf install xclip   # Fedora
```

### Windows / WSL

Works out of the box (uses PowerShell `System.Windows.Forms.Clipboard`).

## Commands

```
sshshot              Setup config and start monitoring
sshshot start        Start monitoring (select target)
sshshot stop         Stop monitoring
sshshot status       Show running status and target
sshshot config       Modify remotes configuration
sshshot uninstall    Remove config files
```

## Features

- Auto-detects SSH remotes from `~/.ssh/config` and shell history
- **Local mode**: Saves to `~/sshshot-screenshots/`, copies path to clipboard
- **Remote mode**: Uploads via SSH, copies remote path to clipboard
- Fast SSH with ControlMaster connection reuse
- Tracks per-source hashes — Mac file-saved and clipboard screenshots don't collide
- WSL support (reads Windows clipboard)

## How it works

1. Polls clipboard / screenshot folder for new images (200 ms interval)
2. Detects changes via per-source MD5 hash comparison
3. Uploads via SSH or saves locally
4. Copies absolute path to clipboard for easy pasting

## Roadmap

- [ ] Linux Wayland support (`wl-clipboard`)
- [ ] Replace 200 ms polling with native file-system events (`fs.watch` / `chokidar`) for the macOS screenshot folder
- [ ] Record macOS demo gif (currently shows the original Linux demo)
- [ ] Record Linux X11 demo gif
- [ ] Test suite (Vitest)

## Acknowledgements

Built on top of [clipshot](https://github.com/HendrikYtt/clipshot) by Hendrik Ytt. macOS support originally proposed in [clipshot#1](https://github.com/HendrikYtt/clipshot/pull/1) by amoghbanta.

## License

MIT — see [LICENSE](./LICENSE).
