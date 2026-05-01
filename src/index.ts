#!/usr/bin/env node

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn, execSync } from 'child_process'
import { Config, loadConfig, saveConfig, detectSSHRemotes } from './config'
import { promptConfirm, promptSelect, promptInput, promptMultiSelect } from './prompts'
import { startMonitor } from './monitor'

const isWindows = process.platform === 'win32'

interface ProcessInfo {
  pid: number
  command: string
}

function findSshshotProcesses(): ProcessInfo[] {
  const processes: ProcessInfo[] = []

  try {
    if (isWindows) {
      // Use PowerShell to get node processes with command line (WMIC is deprecated)
      const psScript = `$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -like '*sshshot*' -and $_.CommandLine -like '*--daemon*' } | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation`
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
      const result = execSync(
        `powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${encoded}`,
        { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )

      for (const line of result.split('\n').slice(1)) {
        // Skip header
        if (!line.trim()) continue
        // CSV format: "ProcessId","CommandLine"
        const match = line.match(/"(\d+)","(.*)"/)
        if (match) {
          const pid = parseInt(match[1])
          if (!isNaN(pid) && pid !== process.pid) {
            processes.push({ pid, command: match[2] })
          }
        }
      }
    } else {
      // Unix: use pgrep
      const result = execSync("pgrep -af 'node.*[s]shshot.*--daemon'", { encoding: 'utf8' })
      for (const line of result.trim().split('\n').filter(Boolean)) {
        const pid = parseInt(line.split(/\s+/)[0])
        if (!isNaN(pid)) {
          processes.push({ pid, command: line })
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
      execSync(`taskkill /PID ${pid}${force ? ' /F' : ''}`, { stdio: 'pipe', windowsHide: true })
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
    if (remoteName && !remotes.includes(remoteName)) {
      remotes.push(remoteName)
      console.log(`Added: ${remoteName}`)
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
    // Linux/macOS: use nohup + shell backgrounding to preserve X11/Wayland access
    // The native clipboard library crashes with Node's detached mode
    const logDir = path.join(os.homedir(), '.config', 'sshshot', 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const cmd = `nohup "${process.execPath}" "${__filename}" --daemon "${remote}" >> "${logDir}/daemon.log" 2>&1 & echo $!`
    const result = execSync(cmd, {
      encoding: 'utf8',
      env: { ...process.env, SHOTMON_BACKGROUND: '1' }
    }).trim()
    console.log(`Started in background (PID: ${result})`)
  }

  console.log(`Logs: ~/.config/sshshot/logs/`)
}

function showHelp(): void {
  console.log(`Usage: sshshot <command>

Commands:
  start      Start monitoring in background
  stop       Stop background process
  status     Show if running
  config     Modify configuration
  uninstall  Remove config and stop process

Run without command to setup/configure.
`)
}

function uninstall(): void {
  // Stop any running process
  const count = killAllSshshotProcesses()
  if (count > 0) {
    console.log('Stopped running process')
  }

  // Remove config directory
  const configDir = path.join(os.homedir(), '.config', 'sshshot')
  if (fs.existsSync(configDir)) {
    fs.rmSync(configDir, { recursive: true })
    console.log(`Removed ${configDir}`)
  }

  console.log('\nNow run: npm uninstall -g sshshot')
}

function stopBackground(): void {
  const count = killAllSshshotProcesses()
  if (count > 0) {
    console.log(`Stopped ${count} process(es)`)
  } else {
    console.log('No sshshot process running')
  }
}

function showStatus(): void {
  const processes = findSshshotProcesses()

  if (processes.length === 0) {
    console.log('Not running')
    return
  }

  for (const proc of processes) {
    // Try to extract target from command line
    const match = proc.command.match(/--daemon\s+(\S+)/)
    if (match) {
      console.log(`Running (PID: ${proc.pid}) -> ${match[1]}`)
    } else {
      console.log(`Running (PID: ${proc.pid})`)
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

async function startCommand(): Promise<void> {
  const config = loadConfig()

  if (!config || config.remotes.length === 0) {
    console.log("No remotes configured. Run 'sshshot' first to set up.")
    process.exit(1)
  }

  // Add "local" option to the list
  const options = ['local', ...config.remotes]

  let selected: string
  if (options.length === 1) {
    selected = options[0]
  } else {
    selected = await promptSelect('Select target', options)
  }

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
    showStatus()
    return
  }

  if (command === 'start') {
    await startCommand()
    return
  }

  if (command === 'config') {
    await runConfig()
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
