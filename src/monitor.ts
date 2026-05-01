import { spawn, spawnSync, execSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getConfigDir, getPidFile, loadConfig } from './config'

const POLL_INTERVAL_MS = 200
const LOG_MAX_AGE_MS = 60 * 60 * 1000 // 1 hour — rotate to a new file
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days — prune older files

// Track hashes per source so the clipboard and file watchers don't collide.
// Without this, processing a file screenshot (B) makes the next clipboard poll
// think the still-present clipboard image (A) is new — re-uploading it.
let lastClipboardHash: string | null = null
let lastFileHash: string | null = null
let logFile: string | null = null
let logStartTime: number = 0
let lastSeenScreenshotMtime: number = 0

// Cross-source dedupe: Cmd+Ctrl+Shift+4 puts the screenshot on the
// clipboard AND saves a file at the same time. Both poll branches would
// otherwise call processNewImage on the same tick, uploading the same
// image twice with two filenames. We keep a small LRU of hashes seen
// in either branch and skip on a hit.
const RECENT_PROCESSED_KEEP = 8
const recentlyProcessedHashes: string[] = []

function markProcessed(hash: string): void {
  if (recentlyProcessedHashes.includes(hash)) return
  recentlyProcessedHashes.push(hash)
  if (recentlyProcessedHashes.length > RECENT_PROCESSED_KEEP) {
    recentlyProcessedHashes.shift()
  }
}

function wasRecentlyProcessed(hash: string): boolean {
  return recentlyProcessedHashes.includes(hash)
}

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'

function isWSL(): boolean {
  if (isWindows) {
    return false
  }
  try {
    const release = fs.readFileSync('/proc/version', 'utf8')
    return release.toLowerCase().includes('microsoft') || release.toLowerCase().includes('wsl')
  } catch {
    return false
  }
}

// Detect a Wayland session. The canonical signal is `XDG_SESSION_TYPE` set
// to 'wayland' by the display manager. As a fallback, `WAYLAND_DISPLAY` is
// set whenever a Wayland compositor is providing clipboard access.
function isWaylandSession(): boolean {
  if (isWindows || isMac) return false
  if (process.env.XDG_SESSION_TYPE === 'wayland') return true
  const wd = process.env.WAYLAND_DISPLAY
  return typeof wd === 'string' && wd.length > 0
}

function getLogDir(): string {
  return path.join(getConfigDir(), 'logs')
}

function ensureLogDir(): void {
  const logDir = getLogDir()
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
}

// Pid-file helpers. The path itself comes from config.ts so monitor.ts
// (writer) and index.ts (reader) can't drift.
function writePidFile(): void {
  const dir = getConfigDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(getPidFile(), String(process.pid))
}

function removePidFile(): void {
  try {
    fs.unlinkSync(getPidFile())
  } catch {
    // already gone or unwritable; nothing to do
  }
}

// Best-effort cleanup of log files older than LOG_RETENTION_MS. Called on
// every log rotation so the directory doesn't grow unbounded over months.
function pruneOldLogs(): void {
  const logDir = getLogDir()
  if (!fs.existsSync(logDir)) return
  const cutoff = Date.now() - LOG_RETENTION_MS
  try {
    for (const f of fs.readdirSync(logDir)) {
      if (!f.startsWith('sshshot-') || !f.endsWith('.log')) continue
      const filePath = path.join(logDir, f)
      try {
        const stat = fs.statSync(filePath)
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath)
        }
      } catch {
        // file disappeared between readdir and stat; ignore
      }
    }
  } catch {
    // log dir disappeared; ignore
  }
}

function createNewLogFile(): string {
  ensureLogDir()
  pruneOldLogs()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `sshshot-${timestamp}.log`
  return path.join(getLogDir(), filename)
}

function log(message: string): void {
  const now = Date.now()
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`

  // Check if we need a new log file
  if (!logFile || now - logStartTime > LOG_MAX_AGE_MS) {
    logFile = createNewLogFile()
    logStartTime = now
  }

  // Write to file
  fs.appendFileSync(logFile, line)

  // Also print to console if not in background
  if (!process.env.SHOTMON_BACKGROUND) {
    process.stdout.write(message + '\n')
  }
}

async function getClipboardImageWindows(): Promise<Buffer | null> {
  // Deterministic temp filename. The original code used a Date.now()
  // timestamp which made every clipboard read create a NEW file, and any
  // process kill between PowerShell-save and read-and-unlink left an
  // orphan. Polling at 5 Hz quickly accumulated orphans in %TEMP% over
  // the daemon's lifetime. With a fixed name, the worst case is one
  // orphan total — overwritten on the next clipboard read.
  const tempFileName = 'sshshot-clipboard.png'
  let tempFilePath: string | null = null

  try {
    // PowerShell script to get clipboard image and save directly to temp file
    // This avoids base64 encoding and stdout buffer limits for large images
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
  $tempPath = Join-Path $env:TEMP '${tempFileName}'
  $img.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $tempPath
}
`
    // Encode as UTF-16LE base64 for -EncodedCommand
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64')

    // Use powershell.exe for WSL, powershell for native Windows
    const psCmd = isWindows ? 'powershell' : 'powershell.exe'
    const windowsPath = execSync(
      `${psCmd} -NoProfile -WindowStyle Hidden -EncodedCommand ${encoded}`,
      {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      }
    ).trim()

    if (!windowsPath || windowsPath.length === 0) {
      return null
    }

    // Convert path for WSL if needed. Use spawnSync with array args (NOT
    // execSync with a template string) so a path containing single quotes,
    // backticks, or `$(…)` can't break the command. The path comes from
    // PowerShell output and is normally safe, but defense in depth is free
    // and consistent with the rest of the spawnSync migration.
    if (isWindows) {
      tempFilePath = windowsPath
    } else {
      const wslpathResult = spawnSync('wslpath', [windowsPath], {
        encoding: 'utf8',
        timeout: 2000
      })
      if (wslpathResult.status !== 0 || !wslpathResult.stdout) {
        return null
      }
      tempFilePath = wslpathResult.stdout.trim()
    }

    if (fs.existsSync(tempFilePath)) {
      const imageBuffer = fs.readFileSync(tempFilePath)
      fs.unlinkSync(tempFilePath)
      return imageBuffer
    }

    return null
  } catch {
    // Try to clean up temp file if it was created
    if (tempFilePath) {
      try {
        fs.unlinkSync(tempFilePath)
      } catch {
        // Ignore cleanup errors
      }
    }
    return null
  }
}

async function getClipboardImageX11(): Promise<Buffer | null> {
  // Check if clipboard has an image. Array args, no shell — consistent with
  // the rest of the spawnSync migration.
  const targets = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], {
    encoding: 'utf8',
    timeout: 2000
  })
  if (targets.status !== 0 || !targets.stdout) return null
  if (!targets.stdout.includes('image/png')) return null

  const imageData = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], {
    encoding: 'buffer',
    timeout: 5000,
    maxBuffer: 50 * 1024 * 1024 // 50MB max
  })
  if (imageData.status !== 0 || !imageData.stdout) return null
  return imageData.stdout.length > 0 ? imageData.stdout : null
}

async function getClipboardImageWayland(): Promise<Buffer | null> {
  // wl-paste --list-types tells us if the clipboard holds an image at all,
  // avoiding loading binary data on every poll when no image is present.
  const types = spawnSync('wl-paste', ['--list-types'], {
    encoding: 'utf8',
    timeout: 2000
  })
  if (types.status !== 0 || !types.stdout) return null
  if (!types.stdout.includes('image/png')) return null

  const imageData = spawnSync('wl-paste', ['--type', 'image/png', '--no-newline'], {
    encoding: 'buffer',
    timeout: 5000,
    maxBuffer: 50 * 1024 * 1024 // 50MB max
  })
  if (imageData.status !== 0 || !imageData.stdout) return null
  return imageData.stdout.length > 0 ? imageData.stdout : null
}

function getMacScreenshotDir(): string {
  const result = spawnSync('defaults', ['read', 'com.apple.screencapture', 'location'], {
    encoding: 'utf8',
    timeout: 2000
  })
  if (result.status === 0 && result.stdout) {
    const loc = result.stdout.trim()
    if (loc) return loc
  }
  // The 'defaults read' exits non-zero when the key is unset — fall back
  // to the OS default.
  return path.join(os.homedir(), 'Desktop')
}

async function getClipboardImageMac(): Promise<Buffer | null> {
  // pngpaste writes the clipboard PNG to stdout; with `-` it writes raw bytes
  // (no trailing newline). Exits non-zero if the clipboard has no image.
  const result = spawnSync('pngpaste', ['-'], {
    encoding: 'buffer',
    timeout: 5000,
    maxBuffer: 50 * 1024 * 1024 // 50MB max
  })
  if (result.status !== 0 || !result.stdout) return null
  return result.stdout.length > 0 ? result.stdout : null
}

// macOS screenshot filenames are localized. The English default is
// "Screenshot YYYY-MM-DD at ...png" but other system languages use
// completely different prefixes. The user can also override the prefix via
// `defaults write com.apple.screencapture name <Custom>`.
//
// We match the known stock prefixes for major locales. The (?=\s|\.|$)
// lookahead replaces a JS \b word boundary because \b is ASCII-only —
// after CJK characters (e.g. スクリーンショット), \b fails since JS sees
// the prior character class as 'non-word'. Lookahead-on-separator is
// locale-independent and behaves identically for all alphabets.
export const MAC_SCREENSHOT_FILENAME_RE =
  /^(Screenshot|Bildschirm(foto|aufnahme)|Capture (d'écran|d'ecran)|Captura (de pantalla|de tela)|Schermata|Schermafbeelding|Skärmavbild|Skjermbilde|Skærmbillede|スクリーンショット|スクリーンキャプチャ|화면 캡처|Снимок экрана|Capture)(?=\s|\.|$).*\.png$/i

// Optional second matcher built at startup from
// `defaults read com.apple.screencapture name` so users who customized
// their screenshot prefix (e.g. `defaults write com.apple.screencapture
// name "MyShot"`) are still detected. Stays null when the user hasn't
// overridden the default.
let customMacScreenshotRe: RegExp | null = null

// Build a filename regex from a user-provided prefix, escaping regex
// metacharacters. Exported for tests.
export function buildCustomScreenshotRegex(prefix: string): RegExp {
  const trimmed = prefix.trim()
  if (trimmed.length === 0) {
    throw new Error('Empty prefix')
  }
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}(?=\\s|\\.|$).*\\.png$`, 'i')
}

// Read the user's custom screenshot name override at daemon startup.
// macOS-only — the keys don't exist on other platforms. Logs nothing on the
// no-override path; logs a one-line confirmation when an override is found.
export function detectCustomMacScreenshotPrefix(): string | null {
  if (!isMac) return null
  const result = spawnSync('defaults', ['read', 'com.apple.screencapture', 'name'], {
    encoding: 'utf8',
    timeout: 2000
  })
  if (result.status !== 0 || !result.stdout) return null
  const name = result.stdout.trim()
  // `defaults read` returns the literal value with surrounding double quotes
  // for strings containing spaces. Strip them.
  const unquoted = name.replace(/^"(.*)"$/, '$1')
  return unquoted.length > 0 ? unquoted : null
}

export function isMacScreenshotFilename(filename: string): boolean {
  if (MAC_SCREENSHOT_FILENAME_RE.test(filename)) return true
  if (customMacScreenshotRe && customMacScreenshotRe.test(filename)) return true
  return false
}

// mtime of the candidate file we observed on the previous poll. Used to
// gate the readFileSync until the file has stayed at the same mtime for
// at least one full poll cycle — proof that the OS isn't still flushing
// writes. macOS Cmd+Shift+3 on a large display can take >300ms to fully
// write; the previous heuristic ('skip if mtime is younger than 300ms')
// would let through a partially-written file in that window.
let lastObservedScreenshotMtime = 0

function getLatestMacScreenshot(): Buffer | null {
  const dir = getMacScreenshotDir()
  try {
    const files = fs
      .readdirSync(dir)
      .filter(isMacScreenshotFilename)
      .map((f) => {
        const fullPath = path.join(dir, f)
        const stat = fs.statSync(fullPath)
        return { path: fullPath, mtime: stat.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)

    if (files.length === 0) return null

    const newest = files[0]
    if (newest.mtime <= lastSeenScreenshotMtime) return null

    // Stability check: only read if the mtime has been the same as it was
    // on the previous poll. If it changed, the OS is still flushing writes;
    // wait another poll. This handles slow filesystems and large screenshots
    // where the write spans multiple poll cycles.
    if (newest.mtime !== lastObservedScreenshotMtime) {
      lastObservedScreenshotMtime = newest.mtime
      return null
    }

    // Belt-and-suspenders: even after stability, require ≥300ms since the
    // last write. Catches edge cases where the write completes between
    // polls and stability is only one poll old.
    const now = Date.now()
    if (now - newest.mtime < 300) {
      return null
    }

    lastSeenScreenshotMtime = newest.mtime
    lastObservedScreenshotMtime = 0 // reset for the next file
    return fs.readFileSync(newest.path)
  } catch {
    return null
  }
}

async function getClipboardImage(): Promise<Buffer | null> {
  if (isWindows || isWSL()) {
    return getClipboardImageWindows()
  }
  if (isMac) {
    return getClipboardImageMac()
  }
  if (isWaylandSession()) {
    return getClipboardImageWayland()
  }
  return getClipboardImageX11()
}

export function getImageHash(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex')
}

export function generateFilename(): string {
  // Include milliseconds + a 4-char random suffix so two screenshots taken
  // in the same second don't collide on the remote (Cmd+Shift+3 spam,
  // back-to-back paste from clipboard, etc). The previous one-per-second
  // resolution silently overwrote earlier images.
  const now = new Date()
  // toISOString() → 2026-05-01T12:34:56.789Z → slice off the trailing 'Z'
  // and dot/colon-replace → 2026-05-01T12-34-56-789
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 23)
  const suffix = crypto.randomBytes(2).toString('hex') // 4 hex chars
  return `screenshot-${timestamp}-${suffix}.png`
}

// Defensive: pipeToRemote interpolates `filename` into a remote shell
// command. generateFilename() only produces strings matching this regex
// today, but if generation ever changes (e.g. accepts user input), this
// guard keeps the shell-injection surface closed.
export const SAFE_REMOTE_FILENAME_RE =
  /^screenshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{4}\.png$/

function getLocalScreenshotDir(): string {
  return path.join(os.homedir(), 'sshshot-screenshots')
}

function saveLocal(imageBuffer: Buffer, filename: string): { success: boolean; path: string } {
  const dir = getLocalScreenshotDir()
  const filePath = path.join(dir, filename)
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, imageBuffer)
    return { success: true, path: filePath }
  } catch {
    return { success: false, path: filePath }
  }
}

// Cache `$HOME` per remote so we don't open a new SSH connection on every
// upload. ControlMaster setups make this near-free, but plenty of users
// don't enable it — and the cost is one extra round-trip per first upload
// to a remote per daemon lifetime.
const remoteHomeCache = new Map<string, string>()

function getRemoteHomePath(remote: string): string {
  const cached = remoteHomeCache.get(remote)
  if (cached !== undefined) return cached

  // Primary: ask the remote directly. Handles non-standard home dirs
  // (/Users/<user> on macOS, /data/<user> on some configs, custom HOME
  // overrides in /etc/passwd). Spawn with array args — no shell.
  // The `--` after the options terminates ssh's option parsing so a remote
  // name starting with `-` (e.g. a typo or a malicious `-oProxyCommand=…`)
  // can't be mistaken for a flag. The CLI input layer already rejects such
  // names via isValidRemoteName, but defense in depth is cheap.
  const echoResult = spawnSync(
    'ssh',
    ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', '--', remote, 'echo $HOME'],
    { encoding: 'utf8', timeout: 7000 }
  )
  if (echoResult.status === 0 && echoResult.stdout) {
    const home = echoResult.stdout.trim()
    if (home.startsWith('/')) {
      remoteHomeCache.set(remote, home)
      return home
    }
  }

  // Fallback 1: extract username from user@host format and guess.
  const userAtHost = remote.match(/^([^@]+)@/)
  if (userAtHost) {
    const user = userAtHost[1]
    const guess = user === 'root' ? '/root' : `/home/${user}`
    remoteHomeCache.set(remote, guess)
    return guess
  }

  // Fallback 2: named host without user — resolve via `ssh -G` and guess.
  // Use spawnSync with array args so a maliciously-crafted `remote`
  // containing shell metacharacters cannot inject.
  const sshGResult = spawnSync('ssh', ['-G', '--', remote], {
    encoding: 'utf8',
    timeout: 3000
  })
  if (sshGResult.status === 0 && sshGResult.stdout) {
    const userMatch = sshGResult.stdout.match(/^user\s+(.+)$/m)
    if (userMatch) {
      const user = userMatch[1]
      const guess = user === 'root' ? '/root' : `/home/${user}`
      remoteHomeCache.set(remote, guess)
      return guess
    }
  }

  // Last resort — shell ~ expansion on the remote will still resolve correctly
  // for the displayed path; only the absolute path shown to the user is
  // approximate.
  return '~'
}

// Cap concurrent ssh uploads. Without this, a burst of screenshots (e.g.
// Cmd+Shift+3 spam, or a slow remote causing pile-up) would spawn one ssh
// process per screenshot — five rapid screenshots = five simultaneous ssh
// sessions opening connections to the same host. Two-at-a-time gives some
// pipelining benefit without thrashing the user's connection budget or
// triggering MaxSessions limits on the remote sshd.
const MAX_CONCURRENT_UPLOADS = 2
let activeUploadCount = 0
const uploadWaitQueue: Array<() => void> = []

function acquireUploadSlot(): Promise<void> {
  if (activeUploadCount < MAX_CONCURRENT_UPLOADS) {
    activeUploadCount++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    uploadWaitQueue.push(() => {
      activeUploadCount++
      resolve()
    })
  })
}

function releaseUploadSlot(): void {
  activeUploadCount--
  const next = uploadWaitQueue.shift()
  if (next) next()
}

async function pipeToRemote(
  imageBuffer: Buffer,
  remote: string,
  filename: string
): Promise<{ success: boolean; path: string; error?: string }> {
  if (!SAFE_REMOTE_FILENAME_RE.test(filename)) {
    return Promise.resolve({
      success: false,
      path: '',
      error: `Refusing to ssh-pipe with unexpected filename shape: ${JSON.stringify(filename)}`
    })
  }

  await acquireUploadSlot()
  const homeDir = getRemoteHomePath(remote)
  const remotePath = `${homeDir}/sshshot-screenshots/${filename}`

  return new Promise((resolve) => {
    // Use ~ in the command so SSH resolves it correctly. ConnectTimeout=5
    // fails fast (~5s) on an unreachable remote instead of letting SSH's
    // default ~75s TCP retry leave the daemon spinning on a stuck upload.
    const proc = spawn(
      'ssh',
      [
        '-o',
        'ConnectTimeout=5',
        // `--` terminates ssh's option parsing — see getRemoteHomePath for
        // the rationale. The validator at config-input time should already
        // have rejected `-`-prefixed remotes; this is the defense-in-depth.
        '--',
        remote,
        `mkdir -p ~/sshshot-screenshots && cat > ~/sshshot-screenshots/${filename}`
      ],
      {
        windowsHide: true
      }
    )

    let stderr = ''
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.stdin.write(imageBuffer)
    proc.stdin.end()

    proc.on('close', (code) => {
      // Return the explicit path for clipboard, but command used ~ for reliability
      releaseUploadSlot()
      resolve({ success: code === 0, path: remotePath, error: stderr.trim() || undefined })
    })

    proc.on('error', (err) => {
      releaseUploadSlot()
      resolve({ success: false, path: remotePath, error: err.message })
    })
  })
}

// Each copy-to-clipboard helper now returns success-bool so the caller can
// log accurately. Previously a failing xclip (no X11 display, missing
// binary) silently returned and the daemon logged "-> Copied to clipboard"
// regardless. Users would paste and get the previous clipboard contents.
function copyToClipboardWindows(text: string): boolean {
  if (isWindows) {
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', '$input | Set-Clipboard'],
      { input: text, timeout: 2000, windowsHide: true }
    )
    return result.status === 0
  }
  // WSL: clip.exe reads stdin directly, no echo needed
  const result = spawnSync('clip.exe', [], { input: text, timeout: 2000 })
  return result.status === 0
}

function copyToClipboardX11(text: string): boolean {
  // xclip -selection clipboard reads text from stdin when no `-i <file>` is
  // given. Spawn with array args; no shell, no quote-escaping needed.
  const result = spawnSync('xclip', ['-selection', 'clipboard'], {
    input: text,
    timeout: 2000
  })
  return result.status === 0
}

function copyToClipboardWayland(text: string): boolean {
  // wl-copy reads stdin and copies to the clipboard. Spawn with array args;
  // no shell, no escaping. --trim-newline strips the trailing newline most
  // shells would append; we never feed one but it's defensive.
  const result = spawnSync('wl-copy', ['--trim-newline'], { input: text, timeout: 2000 })
  return result.status === 0
}

async function copyToClipboardMac(text: string): Promise<boolean> {
  // Spawn pbcopy and pipe text via stdin — avoids the macOS /bin/echo `-n` bug
  // (the shell builtin honors -n but the binary doesn't, so `echo -n` would
  // copy `-n FILE_PATH` into the clipboard) and skips shell-escaping entirely.
  return new Promise<boolean>((resolve) => {
    const proc = spawn('pbcopy')
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
    proc.stdin.write(text)
    proc.stdin.end()
  })
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (isWindows || isWSL()) return copyToClipboardWindows(text)
  if (isMac) return copyToClipboardMac(text)
  if (isWaylandSession()) return copyToClipboardWayland(text)
  return copyToClipboardX11(text)
}

// Module-level pause-state tracker so we log the transition once instead
// of on every paused screenshot. Updated by checkPaused() at the top of
// processNewImage. Initialized to false; the first paused poll logs
// "Paused — skipping…".
let lastSeenPausedState = false

function checkPaused(): boolean {
  const paused = Boolean(loadConfig()?.paused)
  if (paused !== lastSeenPausedState) {
    log(
      paused
        ? 'Paused — clipboard untouched until resume'
        : 'Resumed — processing screenshots again'
    )
    lastSeenPausedState = paused
  }
  return paused
}

async function processNewImage(
  imageBuffer: Buffer,
  remote: string,
  source: 'clipboard' | 'file'
): Promise<void> {
  // Honor `sshshot pause` — daemon stays alive but skips processing so
  // the user can take non-AI screenshots without `stop`/`start`+re-select.
  if (checkPaused()) return

  const filename = generateFilename()
  const size = Math.round(imageBuffer.length / 1024)

  log(`New screenshot (${source}): ${filename} (${size}KB)`)

  if (remote === 'local') {
    const result = saveLocal(imageBuffer, filename)
    if (result.success) {
      log(`  -> Saved: ${result.path}`)
      const copied = await copyToClipboard(result.path)
      log(copied ? `  -> Copied to clipboard` : `  -> Clipboard write failed`)
    } else {
      log(`  -> Failed to save locally`)
    }
  } else {
    const result = await pipeToRemote(imageBuffer, remote, filename)
    if (result.success) {
      log(`  -> Sent to ${remote}:${result.path}`)
      const copied = await copyToClipboard(result.path)
      log(copied ? `  -> Copied to clipboard` : `  -> Clipboard write failed`)
    } else {
      log(`  -> Failed to send to ${remote}`)
      if (result.error) {
        log(`  -> Error: ${result.error}`)
      }
    }
  }
}

// Last validated target (sticky cache so a hand-edit typo on
// config.activeTarget doesn't make the daemon switch to a non-existent
// remote and silently drop screenshots).
let lastValidTarget: string | null = null
// Last invalid value we already warned about — prevents log spam when the
// poll loop reads the same bad config value 5 times per second.
let lastWarnedInvalidTarget: string | null = null

// Resolves the effective target on each poll: prefers config.activeTarget if
// set (so `sshshot target <name>` switches the daemon at runtime without a
// restart), falls back to the remote chosen at daemon-start otherwise.
//
// Validates the candidate against the configured remotes (+ "local"). If a
// hand-edit set activeTarget to a typo'd or removed remote, we log a one-
// shot warning and keep using the last known good target instead of
// silently shipping screenshots into the void.
function resolveActiveTarget(initialRemote: string): string {
  const config = loadConfig()
  const candidate = config?.activeTarget ?? initialRemote
  const valid = new Set<string>(['local', ...(config?.remotes ?? []), initialRemote])

  if (valid.has(candidate)) {
    lastValidTarget = candidate
    lastWarnedInvalidTarget = null
    return candidate
  }

  if (candidate !== lastWarnedInvalidTarget) {
    const fallback = lastValidTarget ?? initialRemote
    log(`Warning: config.activeTarget '${candidate}' is not in your configured remotes.`)
    log(`  Known: ${[...valid].join(', ')}`)
    log(`  Falling back to: ${fallback}`)
    log(`  Fix: 'sshshot target <name>' or edit ~/.config/sshshot/config.json`)
    lastWarnedInvalidTarget = candidate
  }
  return lastValidTarget ?? initialRemote
}

// Maximum time we'll wait for in-flight uploads on graceful shutdown
// before exiting anyway. Five seconds is long enough for a typical
// screenshot (single-digit MB) to finish uploading over a fast SSH
// connection, short enough that a hung remote doesn't make Ctrl+C feel
// broken.
const SHUTDOWN_GRACE_MS = 5000

export async function startMonitor(initialRemote: string): Promise<void> {
  // In-flight upload tracking so a SIGINT/SIGTERM mid-upload doesn't sever
  // an SSH connection and leave a partial PNG on the remote. processNewImage
  // calls register themselves in this set; the shutdown handler awaits them.
  const inFlightUploads = new Set<Promise<unknown>>()
  let shutdownRequested = false
  let pollTimer: NodeJS.Timeout | null = null

  function trackUpload<T>(p: Promise<T>): Promise<T> {
    inFlightUploads.add(p)
    void p.finally(() => inFlightUploads.delete(p))
    return p
  }

  async function gracefulShutdown(signal: string): Promise<void> {
    if (shutdownRequested) {
      // Second signal — user clearly wants out. Skip the wait.
      log(`Received second ${signal}; exiting immediately`)
      removePidFile()
      process.exit(1)
    }
    shutdownRequested = true

    // Stop new polls from firing. In-flight ones will complete or be aborted
    // by the timeout below.
    if (pollTimer) clearInterval(pollTimer)

    if (inFlightUploads.size === 0) {
      log(`Received ${signal}; no in-flight uploads, exiting cleanly`)
    } else {
      log(
        `Received ${signal}; waiting up to ${SHUTDOWN_GRACE_MS}ms for ` +
          `${inFlightUploads.size} in-flight upload(s) to finish...`
      )
      const allDone = Promise.allSettled(Array.from(inFlightUploads))
      const timedOut = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS)
      )
      const winner = await Promise.race([allDone.then(() => 'done' as const), timedOut])
      if (winner === 'timeout' && inFlightUploads.size > 0) {
        log(`  ${inFlightUploads.size} upload(s) still pending after grace period; exiting anyway`)
      } else {
        log('  All uploads completed.')
      }
    }
    removePidFile()
    process.exit(0)
  }

  // Write PID file early so 'sshshot status' / 'stop' can find us reliably
  // even if pgrep is a quirky busybox build. Cleanup happens via
  // gracefulShutdown above, plus a defensive sync removePidFile on
  // 'exit' for the case where the process dies via path the signal
  // handlers don't cover (uncaught throw, etc.).
  writePidFile()
  process.once('SIGINT', () => {
    void gracefulShutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    void gracefulShutdown('SIGTERM')
  })
  process.on('exit', removePidFile)

  // Initialize logging
  logFile = createNewLogFile()
  logStartTime = Date.now()

  const wsl = isWSL()
  const wayland = isWaylandSession()
  const env = isWindows
    ? 'Windows'
    : wsl
      ? 'WSL'
      : isMac
        ? 'macOS'
        : wayland
          ? 'Linux (Wayland)'
          : 'Linux (X11)'
  let currentRemote = resolveActiveTarget(initialRemote)
  log(`Starting monitor for: ${currentRemote}`)
  log(`Environment: ${env}`)
  log(`Log file: ${logFile}`)
  if (currentRemote === 'local') {
    log(`Saving to: ${getLocalScreenshotDir()}`)
  }

  // macOS-specific initialization
  if (isMac) {
    // Check pngpaste availability
    try {
      execSync('which pngpaste', { encoding: 'utf8', timeout: 2000 })
    } catch {
      log('Warning: pngpaste not found. Install with: brew install pngpaste')
      log('  Clipboard detection disabled — file watcher still active.')
    }

    // Pick up a user-customized screenshot name prefix (set via
    // `defaults write com.apple.screencapture name <Custom>`). Stays unset
    // on stock systems so the locale matcher above is the sole filter.
    const customPrefix = detectCustomMacScreenshotPrefix()
    if (customPrefix) {
      try {
        customMacScreenshotRe = buildCustomScreenshotRegex(customPrefix)
        log(`Custom screenshot prefix detected: '${customPrefix}'`)
      } catch (err) {
        log(
          `Could not compile custom screenshot prefix '${customPrefix}': ${(err as Error).message}`
        )
      }
    }

    // Initialize lastSeenScreenshotMtime to newest existing screenshot file
    // (across all supported locale prefixes — see MAC_SCREENSHOT_FILENAME_RE)
    const screenshotDir = getMacScreenshotDir()
    try {
      const mtimes = fs
        .readdirSync(screenshotDir)
        .filter(isMacScreenshotFilename)
        .map((f) => fs.statSync(path.join(screenshotDir, f)).mtimeMs)
      if (mtimes.length > 0) {
        lastSeenScreenshotMtime = Math.max(...mtimes)
      }
    } catch {
      // Directory might not exist
    }
    log(`Watching screenshot dir: ${screenshotDir}`)
  }

  // Linux clipboard prerequisites — warn loudly if the right tool is missing.
  if (!isWindows && !wsl && !isMac) {
    if (wayland) {
      const check = spawnSync('which', ['wl-paste'], { encoding: 'utf8', timeout: 2000 })
      if (check.status !== 0) {
        log('Warning: wl-clipboard not found (Wayland session detected). Install with:')
        log('  Debian/Ubuntu:  sudo apt install wl-clipboard')
        log('  Fedora:         sudo dnf install wl-clipboard')
        log('  Arch:           sudo pacman -S wl-clipboard')
        log('  Clipboard detection will silently fail until wl-clipboard is installed.')
      }
    } else {
      const check = spawnSync('which', ['xclip'], { encoding: 'utf8', timeout: 2000 })
      if (check.status !== 0) {
        log('Warning: xclip not found (X11 session). Install with:')
        log('  Debian/Ubuntu:  sudo apt install xclip')
        log('  Fedora:         sudo dnf install xclip')
        log('  Arch:           sudo pacman -S xclip')
        log('  Clipboard detection will silently fail until xclip is installed.')
      }
    }
  }

  log('')
  log('Monitoring clipboard... (Ctrl+C to stop)')
  log('')

  // Initialize with current clipboard state
  const initialImage = await getClipboardImage()
  if (initialImage) {
    lastClipboardHash = getImageHash(initialImage)
  }

  // Extracted helper so both the poll loop and the macOS fs.watch callback
  // can drive the file-screenshot check. processNewImage's promise is
  // tracked so graceful shutdown can wait for the upload to finish.
  const checkFileScreenshot = async (): Promise<void> => {
    if (!isMac || shutdownRequested) return
    const fileBuffer = getLatestMacScreenshot()
    if (!fileBuffer) return
    const fileHash = getImageHash(fileBuffer)
    if (fileHash !== lastFileHash && !wasRecentlyProcessed(fileHash)) {
      lastFileHash = fileHash
      markProcessed(fileHash)
      await trackUpload(processNewImage(fileBuffer, currentRemote, 'file'))
    }
  }

  // macOS: prefer event-driven detection via fs.watch over the 200ms
  // readdir/stat poll. The screenshot dir typically has many files so
  // every poll was running readdir + stat over the whole list — wasted
  // CPU. fs.watch wakes us only when something changes.
  //
  // Caveats:
  // - debounce 300ms after the last event so a multi-write screenshot
  //   (write+close+rename sequence from screencapture) is read once
  //   when stable, not three times mid-write
  // - fs.watch is best-effort: it can miss events on network mounts,
  //   sandboxed dirs, or some macOS edge cases — the poll loop below
  //   keeps calling checkFileScreenshot() as a backstop
  let watcher: fs.FSWatcher | null = null
  let watchDebounce: NodeJS.Timeout | null = null
  if (isMac) {
    const screenshotDir = getMacScreenshotDir()
    try {
      watcher = fs.watch(screenshotDir, (_event, filename) => {
        if (!filename || !isMacScreenshotFilename(filename)) return
        if (watchDebounce) clearTimeout(watchDebounce)
        watchDebounce = setTimeout(() => {
          watchDebounce = null
          void checkFileScreenshot()
        }, 300)
      })
      // The watcher can die mid-lifetime — common cause is the directory
      // being recreated by a sync tool (iCloud Drive, Dropbox), or the
      // user changing the screenshot location. Without an error handler,
      // failure was silent and the only signal was 'screenshots stopped
      // working'. Now we log + null out the watcher so the polling
      // fallback keeps catching new screenshots.
      watcher.on('error', (err: Error) => {
        log(`fs.watch error on ${screenshotDir}: ${err.message}`)
        log('  Continuing on polling fallback. Restart the daemon to retry fs.watch.')
        try {
          watcher?.close()
        } catch {
          /* already closed */
        }
        watcher = null
      })
      log(`fs.watch active on ${screenshotDir}`)
    } catch (err) {
      log(`fs.watch setup failed; using polling fallback: ${(err as Error).message}`)
    }

    // Cleanup the watcher on the same exit signals as the PID file.
    process.on('exit', () => {
      if (watcher) watcher.close()
      if (watchDebounce) clearTimeout(watchDebounce)
    })
  }

  // Re-entrancy guard: if a poll iteration takes longer than POLL_INTERVAL_MS
  // (e.g. a slow ssh upload, a hanging PowerShell on Windows), setInterval
  // would otherwise fire a second poll on top of the first — concurrent
  // clipboard reads spawn duplicate xclip/PowerShell processes, and the
  // upload semaphore can be flooded by the same image being submitted twice
  // before the first lap finishes updating lastClipboardHash. The guard
  // makes the loop self-throttling: a long iteration just delays the next
  // tick rather than stacking work.
  let pollInFlight = false

  const poll = async () => {
    if (shutdownRequested || pollInFlight) return
    pollInFlight = true
    try {
      // Re-resolve target each cycle so `sshshot target <name>` takes effect
      // without restarting the daemon.
      const target = resolveActiveTarget(initialRemote)
      if (target !== currentRemote) {
        log(`Active target changed: ${currentRemote} -> ${target}`)
        currentRemote = target
      }

      // Check clipboard
      const imageBuffer = await getClipboardImage()

      if (imageBuffer) {
        const currentHash = getImageHash(imageBuffer)
        if (currentHash !== lastClipboardHash && !wasRecentlyProcessed(currentHash)) {
          lastClipboardHash = currentHash
          markProcessed(currentHash)
          await trackUpload(processNewImage(imageBuffer, currentRemote, 'clipboard'))
        }
      }

      // macOS file watcher: served primarily by fs.watch above; this poll
      // remains as a safety net if fs.watch missed an event.
      await checkFileScreenshot()
    } catch (err) {
      log(`Error: ${err}`)
    } finally {
      pollInFlight = false
    }
  }

  // Start polling. Wrap the async poll() so setInterval gets a void-returning
  // callback (otherwise no-misused-promises flags the unhandled Promise).
  pollTimer = setInterval(() => {
    void poll()
  }, POLL_INTERVAL_MS)

  // Keep process running
  await new Promise(() => {})
}
