import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'

export interface SSHHost {
  name: string
  hostname?: string
  user?: string
}

export interface Config {
  remotes: string[]
  // Active target for the daemon. When set, the daemon switches to this remote
  // on its next poll cycle without restarting. Updated via `sshshot target <name>`.
  // Set to "local" to save screenshots locally instead of uploading.
  activeTarget?: string
}

export function getConfigDir(): string {
  return path.join(os.homedir(), '.config', 'sshshot')
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json')
}

// Single source of truth for the daemon's pid file path. Imported by both
// monitor.ts (writer) and index.ts (reader) to prevent the two from
// drifting if the location ever changes.
export function getPidFile(): string {
  return path.join(getConfigDir(), 'sshshot.pid')
}

// Throttle repeat warnings — the daemon calls loadConfig 5x/sec, so a
// persistent broken file would otherwise log the same line every 200ms.
// Tracking the last error string per category makes log spam stop after
// the first occurrence and resume only when the error message changes
// (e.g. the user partially fixes the file).
let lastReadErrorMessage: string | null = null
let lastParseErrorMessage: string | null = null

export function loadConfig(): Config | null {
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) {
    return null
  }
  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch (err) {
    const msg = (err as Error).message
    if (msg !== lastReadErrorMessage) {
      process.stderr.write(`sshshot: could not read config at ${configPath}: ${msg}\n`)
      lastReadErrorMessage = msg
    }
    return null
  }
  // Successful read — clear any prior read-error suppression so a future
  // failure with the same message does log again.
  lastReadErrorMessage = null
  try {
    const parsed = JSON.parse(content) as Config
    lastParseErrorMessage = null
    return parsed
  } catch (err) {
    // The previous behavior was to throw, which crashed the daemon's poll
    // loop. With this guard the daemon falls back to its start-time target
    // (resolveActiveTarget treats null config as 'no override') and logs
    // a one-shot warning so the user can fix the file.
    const msg = (err as Error).message
    if (msg !== lastParseErrorMessage) {
      process.stderr.write(
        `sshshot: config at ${configPath} is not valid JSON (${msg}). ` +
          `Falling back to defaults; re-run 'sshshot' to recreate.\n`
      )
      lastParseErrorMessage = msg
    }
    return null
  }
}

export function saveConfig(config: Config): void {
  const configPath = getConfigPath()
  const configDir = path.dirname(configPath)
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
}

// Pure parser, exported for tests. Takes the raw text of an ssh_config and
// returns the Host blocks (excluding wildcard patterns).
//
// `Host a b c` declares three aliases sharing the same block — we emit one
// SSHHost per alias so all of them show up in the auto-detect picker. The
// previous parser dropped b and c entirely, so users with shorthand aliases
// like `Host prod-1 prod` had to type the long form by hand.
export function parseSSHConfig(content: string): SSHHost[] {
  const lines = content.split('\n')
  const hosts: SSHHost[] = []
  // currentBlock is a list of host objects sharing one Host directive — all
  // are mutated together when we see HostName / User children.
  let currentBlock: SSHHost[] | null = null

  const flush = () => {
    if (currentBlock) {
      hosts.push(...currentBlock)
      currentBlock = null
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.toLowerCase().startsWith('host ')) {
      flush()
      // Split on whitespace, drop wildcard patterns. A line like
      // `Host * !bad ok` would yield a block with just { name: 'ok' } —
      // we accept the non-wildcard aliases and ignore the rest.
      const aliases = trimmed
        .slice(5)
        .trim()
        .split(/\s+/)
        .filter((n) => n.length > 0 && !n.includes('*') && !n.startsWith('!'))
      if (aliases.length > 0) {
        currentBlock = aliases.map((name) => ({ name }))
      }
    } else if (currentBlock) {
      if (trimmed.toLowerCase().startsWith('hostname ')) {
        const hostname = trimmed.slice(9).trim()
        for (const h of currentBlock) h.hostname = hostname
      } else if (trimmed.toLowerCase().startsWith('user ')) {
        const user = trimmed.slice(5).trim()
        for (const h of currentBlock) h.user = user
      }
    }
  }

  flush()
  return hosts
}

export function detectSSHRemotes(): SSHHost[] {
  const home = os.homedir()
  const sshConfigPath = path.join(home, '.ssh', 'config')

  if (!fs.existsSync(sshConfigPath)) {
    return []
  }

  return parseSSHConfig(fs.readFileSync(sshConfigPath, 'utf-8'))
}
