import { spawn, spawnSync, execSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { loadConfig } from './config'

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

function getConfigDir(): string {
  return path.join(os.homedir(), '.config', 'sshshot')
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

// PID file path. Written by the daemon at startup so process discovery for
// 'sshshot stop'/'status' is a single fs read instead of a fragile pgrep
// regex (which has known portability issues across pgrep variants —
// BusyBox/Alpine notably).
function getPidFile(): string {
  return path.join(getConfigDir(), 'sshshot.pid')
}

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

    // Convert path for WSL if needed
    if (isWindows) {
      tempFilePath = windowsPath
    } else {
      tempFilePath = execSync(`wslpath '${windowsPath}'`, {
        encoding: 'utf8',
        timeout: 2000
      }).trim()
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

async function getClipboardImageNative(): Promise<Buffer | null> {
  try {
    // Check if clipboard has image using xclip
    const targets = execSync('xclip -selection clipboard -t TARGETS -o 2>/dev/null', {
      encoding: 'utf8',
      timeout: 2000
    })

    if (!targets.includes('image/png')) {
      return null
    }

    // Get image data
    const imageData = execSync('xclip -selection clipboard -t image/png -o 2>/dev/null', {
      encoding: 'buffer',
      timeout: 5000,
      maxBuffer: 50 * 1024 * 1024 // 50MB max
    })

    return imageData.length > 0 ? imageData : null
  } catch {
    return null
  }
}

function getMacScreenshotDir(): string {
  try {
    const loc = execSync('defaults read com.apple.screencapture location 2>/dev/null', {
      encoding: 'utf8',
      timeout: 2000
    }).trim()
    if (loc) return loc
  } catch {
    // defaults command failed — key not set
  }
  return path.join(os.homedir(), 'Desktop')
}

async function getClipboardImageMac(): Promise<Buffer | null> {
  try {
    const imageData = execSync('pngpaste - 2>/dev/null', {
      encoding: 'buffer',
      timeout: 5000,
      maxBuffer: 50 * 1024 * 1024 // 50MB max
    })
    return imageData.length > 0 ? imageData : null
  } catch {
    // pngpaste exits non-zero if no image on clipboard
    return null
  }
}

// macOS screenshot filenames are localized. The English default is
// "Screenshot YYYY-MM-DD at ...png" but other system languages use
// completely different prefixes. The user can also override the prefix via
// `defaults write com.apple.screencapture name <Custom>`. We match the known
// stock prefixes for major locales and accept any user-defined prefix that
// looks like a screenshot (single word + space + date-shaped content).
const MAC_SCREENSHOT_FILENAME_RE =
  /^(Screenshot|Bildschirm(foto|aufnahme)|Capture (d'écran|d'ecran)|Captura (de pantalla|de tela)|Schermata|Schermafbeelding|Skärmavbild|Skjermbilde|Skærmbillede|スクリーンショット|スクリーンキャプチャ|화면 캡처|Снимок экрана|Capture)\b.*\.png$/i

function isMacScreenshotFilename(filename: string): boolean {
  return MAC_SCREENSHOT_FILENAME_RE.test(filename)
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
  return getClipboardImageNative()
}

function getImageHash(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex')
}

function generateFilename(): string {
  const now = new Date()
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `screenshot-${timestamp}.png`
}

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

function getRemoteHomePath(remote: string): string {
  // Extract username from user@host format
  const match = remote.match(/^([^@]+)@/)
  if (match) {
    const user = match[1]
    return user === 'root' ? '/root' : `/home/${user}`
  }
  // Named host without user — resolve via `ssh -G`. Use spawnSync with array
  // args (NOT execSync with a template string) so a maliciously-crafted
  // `remote` containing shell metacharacters cannot inject. The `remote`
  // value comes from the user's own ~/.ssh/config which is normally trusted,
  // but defense in depth is cheap.
  const result = spawnSync('ssh', ['-G', remote], { encoding: 'utf8', timeout: 3000 })
  if (result.status === 0 && result.stdout) {
    const userMatch = result.stdout.match(/^user\s+(.+)$/m)
    if (userMatch) {
      const user = userMatch[1]
      return user === 'root' ? '/root' : `/home/${user}`
    }
  }
  return '~'
}

async function pipeToRemote(
  imageBuffer: Buffer,
  remote: string,
  filename: string
): Promise<{ success: boolean; path: string; error?: string }> {
  const homeDir = getRemoteHomePath(remote)
  const remotePath = `${homeDir}/sshshot-screenshots/${filename}`

  return new Promise((resolve) => {
    // Use ~ in the command so SSH resolves it correctly
    const proc = spawn(
      'ssh',
      [remote, `mkdir -p ~/sshshot-screenshots && cat > ~/sshshot-screenshots/${filename}`],
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
      resolve({ success: code === 0, path: remotePath, error: stderr.trim() || undefined })
    })

    proc.on('error', (err) => {
      resolve({ success: false, path: remotePath, error: err.message })
    })
  })
}

function copyToClipboardWindows(text: string): void {
  // Spawn the target binary with array args and pipe text via stdin — no
  // shell, no quote-escaping, no shell-injection surface. Same pattern we
  // use for pbcopy on macOS.
  if (isWindows) {
    // PowerShell's pipeline reads from stdin via $input
    spawnSync(
      'powershell',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', '$input | Set-Clipboard'],
      { input: text, timeout: 2000, windowsHide: true }
    )
  } else {
    // WSL: clip.exe reads stdin directly, no echo needed
    spawnSync('clip.exe', [], { input: text, timeout: 2000 })
  }
}

function copyToClipboardNative(text: string): void {
  // xclip -selection clipboard reads text from stdin when no `-i <file>` is
  // given. Spawn with array args; no shell, no quote-escaping needed.
  spawnSync('xclip', ['-selection', 'clipboard'], { input: text, timeout: 2000 })
}

async function copyToClipboardMac(text: string): Promise<void> {
  // Spawn pbcopy and pipe text via stdin — avoids the macOS /bin/echo `-n` bug
  // (the shell builtin honors -n but the binary doesn't, so `echo -n` would
  // copy `-n FILE_PATH` into the clipboard) and skips shell-escaping entirely.
  return new Promise((resolve) => {
    const proc = spawn('pbcopy')
    const finish = () => resolve()
    proc.on('error', finish)
    proc.on('close', finish)
    proc.stdin.write(text)
    proc.stdin.end()
  })
}

async function copyToClipboard(text: string): Promise<void> {
  if (isWindows || isWSL()) {
    copyToClipboardWindows(text)
    return
  }
  if (isMac) {
    await copyToClipboardMac(text)
    return
  }
  copyToClipboardNative(text)
}

async function processNewImage(
  imageBuffer: Buffer,
  remote: string,
  source: 'clipboard' | 'file'
): Promise<void> {
  const filename = generateFilename()
  const size = Math.round(imageBuffer.length / 1024)

  log(`New screenshot (${source}): ${filename} (${size}KB)`)

  if (remote === 'local') {
    const result = saveLocal(imageBuffer, filename)
    if (result.success) {
      log(`  -> Saved: ${result.path}`)
      await copyToClipboard(result.path)
      log(`  -> Copied to clipboard`)
    } else {
      log(`  -> Failed to save locally`)
    }
  } else {
    const result = await pipeToRemote(imageBuffer, remote, filename)
    if (result.success) {
      log(`  -> Sent to ${remote}:${result.path}`)
      await copyToClipboard(result.path)
      log(`  -> Copied to clipboard`)
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

export async function startMonitor(initialRemote: string): Promise<void> {
  // Write PID file early so 'sshshot status' / 'stop' can find us reliably
  // even if pgrep is a quirky busybox build. Cleanup is registered against
  // the common exit signals so an Ctrl+C / SIGTERM removes the file.
  writePidFile()
  process.once('SIGINT', () => {
    removePidFile()
    process.exit(0)
  })
  process.once('SIGTERM', () => {
    removePidFile()
    process.exit(0)
  })
  process.on('exit', removePidFile)

  // Initialize logging
  logFile = createNewLogFile()
  logStartTime = Date.now()

  const wsl = isWSL()
  const env = isWindows ? 'Windows' : wsl ? 'WSL' : isMac ? 'macOS' : 'Linux'
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

  // Linux X11 prerequisites — mirror the macOS pngpaste warning so users
  // get a visible signal when clipboard reads silently fail.
  if (!isWindows && !wsl && !isMac) {
    const xclipCheck = spawnSync('which', ['xclip'], { encoding: 'utf8', timeout: 2000 })
    if (xclipCheck.status !== 0) {
      log('Warning: xclip not found. Install with one of:')
      log('  Debian/Ubuntu:  sudo apt install xclip')
      log('  Fedora:         sudo dnf install xclip')
      log('  Arch:           sudo pacman -S xclip')
      log('  Clipboard detection will silently fail until xclip is installed.')
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

  const poll = async () => {
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
          await processNewImage(imageBuffer, currentRemote, 'clipboard')
        }
      }

      // On macOS, also check for new screenshot files (Cmd+Shift screenshots)
      if (isMac) {
        const fileBuffer = getLatestMacScreenshot()
        if (fileBuffer) {
          const fileHash = getImageHash(fileBuffer)
          if (fileHash !== lastFileHash && !wasRecentlyProcessed(fileHash)) {
            lastFileHash = fileHash
            markProcessed(fileHash)
            await processNewImage(fileBuffer, currentRemote, 'file')
          }
        }
      }
    } catch (err) {
      log(`Error: ${err}`)
    }
  }

  // Start polling. Wrap the async poll() so setInterval gets a void-returning
  // callback (otherwise no-misused-promises flags the unhandled Promise).
  setInterval(() => {
    void poll()
  }, POLL_INTERVAL_MS)

  // Keep process running
  await new Promise(() => {})
}
