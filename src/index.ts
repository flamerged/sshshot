#!/usr/bin/env node

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn, spawnSync, execSync } from 'child_process'
import {
  Config,
  detectSSHRemotes,
  getPidFile,
  isValidRemoteName,
  loadConfig,
  saveConfig
} from './config'
import { promptConfirm, promptSelect, promptInput, promptMultiSelect } from './prompts'
import { startMonitor } from './monitor'
import { runMenubarCommand } from './menubar'

const isWindows = process.platform === 'win32'

interface ProcessInfo {
  pid: number
  // Daemon target if known (parsed from `--daemon <target>` for the pgrep
  // fallback, or read from config when discovery came via PID file). Null
  // when we have no reliable signal — the status command renders accordingly
  // instead of printing a malformed placeholder.
  target: string | null
}

// Returns true if a process with the given pid is alive on the current host.
// `process.kill(pid, 0)` is the standard cross-platform liveness probe.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Cmdline introspection — confirms a PID actually belongs to a sshshot
// daemon before we send it a signal. PIDs get reused; without this check,
// `sshshot stop` could SIGTERM an unrelated process whose PID happened to
// match a stale pid file.
function isSshshotDaemonPid(pid: number): boolean {
  if (isWindows) {
    try {
      const psScript = `$ProgressPreference='SilentlyContinue'; $p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.CommandLine }`
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
      const result = spawnSync(
        'powershell',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
        { encoding: 'utf8', timeout: 2000, windowsHide: true }
      )
      const cmdLine = (result.stdout || '').toLowerCase()
      return cmdLine.includes('sshshot') && cmdLine.includes('--daemon')
    } catch {
      return false
    }
  }
  // Linux + macOS: `ps -p <pid> -o args=` portably prints the full command
  // line with no header. `=` after the column name suppresses the title row.
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 2000
    })
    if (result.status !== 0 || !result.stdout) return false
    const cmd = result.stdout.toLowerCase()
    return cmd.includes('sshshot') && cmd.includes('--daemon')
  } catch {
    return false
  }
}

// Primary: read the PID file the daemon writes at startup. Cross-platform,
// fast (single fs read), no shell quirks. Falls back to pgrep / PowerShell
// only if the PID file is missing or stale (orphan recovery).
function findSshshotProcesses(): ProcessInfo[] {
  const processes: ProcessInfo[] = []

  // Primary: PID file. Both alive AND identity-verified — the file alone
  // isn't enough because PIDs can be recycled between runs.
  try {
    const raw = fs.readFileSync(getPidFile(), 'utf-8').trim()
    const pid = parseInt(raw, 10)
    if (!isNaN(pid) && pid !== process.pid && isProcessAlive(pid) && isSshshotDaemonPid(pid)) {
      // We don't have the daemon's start-time argv from the pid file, but
      // we do know the daemon re-reads config every cycle and switches to
      // config.activeTarget if set — so that's a reliable display value.
      const config = loadConfig()
      processes.push({ pid, target: config?.activeTarget ?? null })
      return processes
    }
  } catch {
    // PID file missing or unreadable; fall through to legacy discovery
  }

  // Fallback: legacy process-listing scan. Used only if the PID file is
  // absent (older daemon, manual cleanup, or daemon launched with the binary
  // moved). Has known fragility on minimal pgrep variants (BusyBox/Alpine);
  // hence the PID-file primary path above.
  try {
    if (isWindows) {
      const psScript = `$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -like '*sshshot*' -and $_.CommandLine -like '*--daemon*' } | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation`
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
      const result = execSync(
        `powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${encoded}`,
        { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )

      for (const line of result.split('\n').slice(1)) {
        if (!line.trim()) continue
        const match = line.match(/"(\d+)","(.*)"/)
        if (match) {
          const pid = parseInt(match[1])
          if (!isNaN(pid) && pid !== process.pid) {
            const targetMatch = match[2].match(/--daemon\s+(\S+)/)
            processes.push({ pid, target: targetMatch ? targetMatch[1] : null })
          }
        }
      }
    } else {
      // -lf prints "PID full-cmdline" — works on both BSD pgrep (macOS,
      // FreeBSD) and GNU/procps pgrep (Linux). The previous flag combo
      // `-af` is GNU-only; on BSD `-a` is silently ignored, which made
      // pgrep emit just PIDs and dropped the target-name extraction below.
      const result = execSync("pgrep -lf 'node.*[s]shshot.*--daemon'", { encoding: 'utf8' })
      for (const line of result.trim().split('\n').filter(Boolean)) {
        const pid = parseInt(line.split(/\s+/)[0])
        if (!isNaN(pid)) {
          const targetMatch = line.match(/--daemon\s+(\S+)/)
          processes.push({ pid, target: targetMatch ? targetMatch[1] : null })
        }
      }
    }
  } catch {
    // No processes found
  }

  return processes
}

function killProcess(pid: number, force = false): void {
  try {
    if (isWindows) {
      const args = ['/PID', String(pid)]
      if (force) args.push('/F')
      spawnSync('taskkill', args, { stdio: 'pipe', windowsHide: true })
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
    }
  } catch {
    // Process may have already exited
  }
}

function killAllSshshotProcesses(): number {
  const processes = findSshshotProcesses()

  for (const proc of processes) {
    killProcess(proc.pid)
  }

  // Check if any survived and force kill
  const remaining = findSshshotProcesses()
  for (const proc of remaining) {
    killProcess(proc.pid, true)
  }

  return processes.length
}

function getVersion(): string {
  const pkgPath = path.join(__dirname, '..', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  return pkg.version
}

// daemon.log captures the daemon's stdout+stderr — anything escaping the
// monitor's own structured logger lands here. The internal logs in
// monitor.ts rotate hourly + prune after 7 days; this one was previously
// append-only forever. Rotate on each start when the file passes a size
// cap so a recurring stderr error (failing ssh, missing xclip, etc.) can't
// silently grow the file unbounded over months.
const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
function rotateDaemonLogIfTooLarge(logDir: string): void {
  const current = path.join(logDir, 'daemon.log')
  let stat: fs.Stats
  try {
    stat = fs.statSync(current)
  } catch {
    return // doesn't exist yet
  }
  if (stat.size < DAEMON_LOG_MAX_BYTES) return
  const archived = path.join(logDir, 'daemon.log.1')
  try {
    fs.rmSync(archived, { force: true })
    fs.renameSync(current, archived)
  } catch {
    // best-effort — if rotation fails (permissions, race), the daemon will
    // just append to the existing file and the cap effectively becomes
    // higher this round. No reason to abort startup over it.
  }
}

async function addRemotes(existing: string[]): Promise<string[]> {
  const remotes = [...existing]

  // Detect SSH hosts from ~/.ssh/config (the only place we read for auto-detection).
  // Shell history is intentionally NOT scanned — that pattern matches credential-stealer
  // malware signatures on Socket and similar scanners. Users without ~/.ssh/config
  // entries can add hosts manually via the "custom SSH remote" prompt below.
  const sshHosts = detectSSHRemotes()
  const detected = sshHosts
    .map((host) => (host.user ? `${host.user}@${host.name}` : host.name))
    .filter((name) => !remotes.includes(name))

  if (detected.length > 0) {
    const selected = await promptMultiSelect(
      'Select SSH remotes from ~/.ssh/config to add (space to toggle, enter to confirm)',
      detected
    )
    for (const name of selected) {
      remotes.push(name)
    }
  }

  // Add custom remotes
  let addMore = await promptConfirm('Add a custom SSH remote?')
  while (addMore) {
    const remoteName = await promptInput('Enter SSH remote (e.g., user@host)')
    if (remoteName) {
      if (!isValidRemoteName(remoteName)) {
        // Block names that ssh would parse as flags (`-oProxyCommand=…`),
        // names with whitespace, and control chars. Empty input is also
        // covered by isValidRemoteName.
        console.log(
          `Rejected: ${JSON.stringify(remoteName)} (must not start with '-' or contain whitespace)`
        )
      } else if (!remotes.includes(remoteName)) {
        remotes.push(remoteName)
        console.log(`Added: ${remoteName}`)
      }
    }
    addMore = await promptConfirm('Add another?')
  }

  return remotes
}

function startBackground(remote: string): void {
  let child

  if (isWindows) {
    // Windows: use detached mode
    child = spawn(process.execPath, [__filename, '--daemon', remote], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SHOTMON_BACKGROUND: '1' },
      windowsHide: true
    })
    child.unref()
    console.log(`Started in background (PID: ${child.pid})`)
  } else {
    // Linux/macOS: spawn detached, redirect stdio to a log file. Previously
    // this used `nohup '...' & echo $!` via execSync — a shell command
    // string with `${remote}` interpolation, which would break or inject
    // if remote contained shell metacharacters. spawn() with array args
    // closes that surface entirely.
    //
    // The earlier comment claimed Node's detached mode crashed the native
    // clipboard library; that library (@crosscopy/clipboard) was removed
    // along with shell-history scanning, so detached spawn is now safe.
    // All clipboard access goes through fresh xclip/wl-copy/pbcopy
    // processes that the daemon spawns per poll.
    const logDir = path.join(os.homedir(), '.config', 'sshshot', 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    rotateDaemonLogIfTooLarge(logDir)
    const logFd = fs.openSync(path.join(logDir, 'daemon.log'), 'a')
    child = spawn(process.execPath, [__filename, '--daemon', remote], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, SHOTMON_BACKGROUND: '1' }
    })
    child.unref()
    fs.closeSync(logFd)
    console.log(`Started in background (PID: ${child.pid})`)
  }

  console.log(`Logs: ~/.config/sshshot/logs/`)
}

function showHelp(): void {
  console.log(`Usage: sshshot <command>

Commands:
  start             Start monitoring in background
  stop              Stop background process
  status [--json]   Show if running (JSON variant for scripts and the menubar)
  target [<name>]   Show or change the active target without restarting the daemon
  pause             Daemon stays alive but stops touching the clipboard
  resume            Resume processing screenshots
  toggle            Flip between pause/resume
  config            Modify configuration
  menubar           Manage the macOS menu-bar plugin (install/uninstall/status)
  uninstall         Remove config and stop process
  version           Print version and exit
  help              Show this help

Run without command to setup/configure.
`)
}

function setActiveTarget(name: string | undefined): void {
  const config = loadConfig()
  if (!config) {
    console.log("No configuration found. Run 'sshshot' first to set up remotes.")
    process.exit(1)
  }

  // No-arg form: print current active target + available targets.
  if (!name) {
    const active = config.activeTarget ?? '(not set — daemon is using its start-time target)'
    console.log(`Active target: ${active}`)
    console.log(`Available:     local, ${config.remotes.join(', ') || '(no remotes configured)'}`)
    return
  }

  const validTargets = ['local', ...config.remotes]
  if (!validTargets.includes(name)) {
    console.log(`Unknown target: ${name}`)
    console.log(`Available:     ${validTargets.join(', ')}`)
    process.exit(1)
  }

  saveConfig({ ...config, activeTarget: name })
  console.log(`Active target set to: ${name}`)
  // The running daemon (if any) re-reads config every poll cycle (~200 ms)
  // and will switch on the next iteration. No restart needed.
}

// Pause/resume/toggle the running daemon without changing target or
// restarting the process. The daemon stays alive (so resume is instant);
// processNewImage early-returns while paused, leaving the user's
// clipboard untouched. Designed for the common "I want a screenshot for
// Slack right now, not for Claude Code" case.
function setPausedState(value: boolean): void {
  const config = loadConfig()
  if (!config) {
    console.log("No configuration found. Run 'sshshot' first to set up remotes.")
    process.exit(1)
  }
  if (Boolean(config.paused) === value) {
    console.log(value ? 'Already paused' : 'Already active')
    return
  }
  saveConfig({ ...config, paused: value })
  if (value) {
    console.log('Paused — sshshot will not touch your clipboard until resume')
    console.log("Resume with: 'sshshot resume' or 'sshshot toggle'")
  } else {
    console.log('Resumed — sshshot is processing screenshots again')
  }
}

function toggleActive(): void {
  const config = loadConfig()
  if (!config) {
    console.log("No configuration found. Run 'sshshot' first to set up remotes.")
    process.exit(1)
  }
  setPausedState(!config.paused)
}

function uninstall(): void {
  // Stop any running process
  const count = killAllSshshotProcesses()
  if (count > 0) {
    console.log('Stopped running process')
  }

  // Remove config directory (which also takes the pid file with it).
  const configDir = path.join(os.homedir(), '.config', 'sshshot')
  if (fs.existsSync(configDir)) {
    fs.rmSync(configDir, { recursive: true })
    console.log(`Removed ${configDir}`)
  }

  console.log('\nNow run: npm uninstall -g @flamerged/sshshot')
}

function stopBackground(): void {
  const count = killAllSshshotProcesses()
  if (count > 0) {
    console.log(`Stopped ${count} process(es)`)
  } else {
    console.log('No sshshot process running')
  }
}

function showStatus(asJson = false): void {
  const processes = findSshshotProcesses()
  const config = loadConfig()
  const paused = Boolean(config?.paused)
  const activeTarget = config?.activeTarget ?? null

  if (asJson) {
    // Machine-readable shape consumed by the menu-bar plugin and any other
    // scripts. Keep the schema stable: changes here ripple into anything
    // parsing this output, so add fields rather than rename.
    // Always include pid/target keys (null when stopped) so external
    // consumers don't have to branch on key presence. `target` is parsed
    // from the daemon's --daemon arg via process listing — distinct from
    // the persisted activeTarget (which the user may have just changed via
    // `sshshot target`). Both surfaced so callers can detect drift.
    const payload =
      processes.length === 0
        ? { running: false, paused, activeTarget, pid: null, target: null }
        : {
            running: true,
            paused,
            activeTarget,
            pid: processes[0].pid,
            target: processes[0].target
          }
    // Emit JSON on the first line, no banner — easier for parsers.
    process.stdout.write(JSON.stringify(payload) + '\n')
    return
  }

  if (processes.length === 0) {
    console.log('Not running')
    return
  }

  // Surface the paused state on the same line — otherwise users wonder
  // why screenshots aren't being processed even though `status` says
  // "Running".
  const pauseLabel = paused ? ' [paused]' : ''

  for (const proc of processes) {
    if (proc.target) {
      console.log(`Running (PID: ${proc.pid}) -> ${proc.target}${pauseLabel}`)
    } else {
      console.log(`Running (PID: ${proc.pid})${pauseLabel}`)
    }
  }
}

async function runConfig(): Promise<Config> {
  let config: Config | null = loadConfig()

  if (!config || config.remotes.length === 0) {
    if (!config) {
      console.log("Welcome! Let's add some SSH remotes.\n")
    } else {
      console.log("No remotes configured. Let's add some.\n")
    }

    const remotes = await addRemotes([])
    config = { remotes }
    saveConfig(config)

    if (remotes.length > 0) {
      console.log(`\nSaved ${remotes.length} remote(s).`)
    }
  } else {
    console.log(`SSH remotes: ${config.remotes.join(', ')}\n`)

    const modify = await promptConfirm('Modify remotes?')
    if (modify) {
      const toKeep = await promptMultiSelect(
        'Select remotes to keep (space to toggle, enter to confirm)',
        config.remotes
      )

      const remotes = await addRemotes(toKeep)
      config = { remotes }
      saveConfig(config)
      console.log(`\nSaved ${remotes.length} remote(s).`)
    }
  }

  return config
}

async function startCommand(targetArg?: string): Promise<void> {
  const config = loadConfig()

  if (!config || config.remotes.length === 0) {
    console.log("No remotes configured. Run 'sshshot' first to set up.")
    process.exit(1)
  }

  // Add "local" option to the list
  const options = ['local', ...config.remotes]

  let selected: string
  if (targetArg) {
    // Non-interactive path: `sshshot start <target>` — required by the
    // menu-bar plugin since SwiftBar can't answer interactive prompts.
    if (!options.includes(targetArg)) {
      console.log(`Unknown target: ${targetArg}`)
      console.log(`Available:     ${options.join(', ')}`)
      process.exit(1)
    }
    selected = targetArg
  } else if (options.length === 1) {
    selected = options[0]
  } else {
    selected = await promptSelect('Select target', options)
  }

  // Persist selection as activeTarget so `sshshot target` reflects it and
  // future daemons read the right target after a restart.
  saveConfig({ ...config, activeTarget: selected })

  // Stop any existing process before starting new one
  const count = killAllSshshotProcesses()
  if (count > 0) {
    console.log(`Stopped previous process`)
  }

  startBackground(selected)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  // Handle --daemon (internal use)
  if (command === '--daemon') {
    const remote = args[1]
    if (remote) {
      await startMonitor(remote)
    }
    return
  }

  // `--version` / `-v` / `version` print the bare version and exit, like
  // most CLIs. Done before the banner so scripts piping `sshshot --version`
  // get a clean version string.
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(getVersion())
    return
  }

  // `status --json` is for machine consumption (menu-bar plugin, scripts).
  // Bypass the human-facing banner so the entire stdout is parseable JSON.
  if (command === 'status' && args.includes('--json')) {
    showStatus(true)
    return
  }

  console.log(`sshshot v${getVersion()}\n`)

  // Handle commands
  if (command === 'help' || command === '--help' || command === '-h') {
    showHelp()
    return
  }

  if (command === 'stop') {
    stopBackground()
    return
  }

  if (command === 'status') {
    // The --json variant is handled above the banner; this branch is the
    // human-readable form only.
    showStatus(false)
    return
  }

  if (command === 'start') {
    await startCommand(args[1])
    return
  }

  if (command === 'target') {
    setActiveTarget(args[1])
    return
  }

  if (command === 'pause') {
    setPausedState(true)
    return
  }

  if (command === 'resume') {
    setPausedState(false)
    return
  }

  if (command === 'toggle') {
    toggleActive()
    return
  }

  if (command === 'config') {
    await runConfig()
    return
  }

  if (command === 'menubar') {
    runMenubarCommand(args[1])
    return
  }

  if (command === 'uninstall') {
    uninstall()
    return
  }

  // No command - run config flow then auto-start
  const config = await runConfig()

  if (config.remotes.length === 0) {
    console.log('No remotes configured. Run sshshot again to add remotes.')
    process.exit(0)
  }

  console.log('\n--- Starting monitor ---\n')
  await startCommand()
}

main().catch(console.error)
