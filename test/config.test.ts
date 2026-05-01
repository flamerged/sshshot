import { describe, expect, it } from 'vitest'
import { parseSSHConfig } from '../src/config'

describe('parseSSHConfig', () => {
  it('returns empty array for empty input', () => {
    expect(parseSSHConfig('')).toEqual([])
  })

  it('parses a single host with hostname + user', () => {
    const input = `Host my-host
  HostName 1.2.3.4
  User myuser
  Port 22
`
    expect(parseSSHConfig(input)).toEqual([
      { name: 'my-host', hostname: '1.2.3.4', user: 'myuser' }
    ])
  })

  it('parses multiple hosts', () => {
    const input = `Host alpha
  HostName a.example.com
  User alice

Host beta
  HostName b.example.com
  User bob
`
    expect(parseSSHConfig(input)).toEqual([
      { name: 'alpha', hostname: 'a.example.com', user: 'alice' },
      { name: 'beta', hostname: 'b.example.com', user: 'bob' }
    ])
  })

  it('skips wildcard host patterns', () => {
    const input = `Host *.example.com
  User everyone

Host real-host
  HostName 5.6.7.8
`
    expect(parseSSHConfig(input)).toEqual([{ name: 'real-host', hostname: '5.6.7.8' }])
  })

  it('handles hosts without hostname (uses name as resolution target)', () => {
    const input = `Host minimal
`
    expect(parseSSHConfig(input)).toEqual([{ name: 'minimal' }])
  })

  it('is case-insensitive for keywords', () => {
    const input = `host my-host
  hostname 1.2.3.4
  USER root
`
    expect(parseSSHConfig(input)).toEqual([{ name: 'my-host', hostname: '1.2.3.4', user: 'root' }])
  })

  it('expands multi-alias Host lines into one SSHHost per alias', () => {
    const input = `Host primary alias-1 alias-2
  HostName 1.2.3.4
  User shared
`
    // All aliases share the same hostname/user — each becomes selectable.
    expect(parseSSHConfig(input)).toEqual([
      { name: 'primary', hostname: '1.2.3.4', user: 'shared' },
      { name: 'alias-1', hostname: '1.2.3.4', user: 'shared' },
      { name: 'alias-2', hostname: '1.2.3.4', user: 'shared' }
    ])
  })

  it('drops wildcard / negation entries from a mixed Host line', () => {
    const input = `Host * !forbidden real
  User shared
`
    // The block is kept (the 'real' alias is non-wildcard); '*' and '!forbidden'
    // are filtered out.
    expect(parseSSHConfig(input)).toEqual([{ name: 'real', user: 'shared' }])
  })

  it('ignores unrelated directives', () => {
    const input = `Host my-host
  HostName 1.2.3.4
  IdentityFile ~/.ssh/id_ed25519
  ProxyJump bastion
  ForwardAgent yes
`
    expect(parseSSHConfig(input)).toEqual([{ name: 'my-host', hostname: '1.2.3.4' }])
  })

  it('handles indented and non-indented entries equivalently', () => {
    const input = `Host my-host
HostName 1.2.3.4
   User space-indented
\tUser tab-indented-overwrites
`
    expect(parseSSHConfig(input)).toEqual([
      { name: 'my-host', hostname: '1.2.3.4', user: 'tab-indented-overwrites' }
    ])
  })

  it('does not crash on stray comments and blank lines', () => {
    const input = `# Hetzner production fleet

Host hetzner-1
  HostName 5.6.7.8
  User deploy

# Below: spare boxes
Host hetzner-2
  HostName 9.10.11.12
`
    expect(parseSSHConfig(input)).toEqual([
      { name: 'hetzner-1', hostname: '5.6.7.8', user: 'deploy' },
      { name: 'hetzner-2', hostname: '9.10.11.12' }
    ])
  })
})
