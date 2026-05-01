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

export function getConfigPath(): string {
  return path.join(os.homedir(), '.config', 'sshshot', 'config.json')
}

export function loadConfig(): Config | null {
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) {
    return null
  }
  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch (err) {
    process.stderr.write(
      `sshshot: could not read config at ${configPath}: ${(err as Error).message}\n`
    )
    return null
  }
  try {
    return JSON.parse(content) as Config
  } catch (err) {
    // The previous behavior was to throw, which crashed the daemon's poll
    // loop. With this guard the daemon falls back to its start-time target
    // (resolveActiveTarget treats null config as 'no override') and logs
    // a one-shot warning so the user can fix the file.
    process.stderr.write(
      `sshshot: config at ${configPath} is not valid JSON (${(err as Error).message}). ` +
        `Falling back to defaults; re-run 'sshshot' to recreate.\n`
    )
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
export function parseSSHConfig(content: string): SSHHost[] {
  const lines = content.split('\n')
  const hosts: SSHHost[] = []
  let currentHost: SSHHost | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.toLowerCase().startsWith('host ')) {
      if (currentHost) {
        hosts.push(currentHost)
      }
      const hostName = trimmed.slice(5).trim().split(/\s+/)[0]
      // Skip wildcard patterns
      if (!hostName.includes('*')) {
        currentHost = { name: hostName }
      } else {
        currentHost = null
      }
    } else if (currentHost) {
      if (trimmed.toLowerCase().startsWith('hostname ')) {
        currentHost.hostname = trimmed.slice(9).trim()
      } else if (trimmed.toLowerCase().startsWith('user ')) {
        currentHost.user = trimmed.slice(5).trim()
      }
    }
  }

  if (currentHost) {
    hosts.push(currentHost)
  }

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
