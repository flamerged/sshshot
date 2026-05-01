import { describe, expect, it } from 'vitest'
import {
  MAC_SCREENSHOT_FILENAME_RE,
  SAFE_REMOTE_FILENAME_RE,
  generateFilename,
  getImageHash,
  isMacScreenshotFilename
} from '../src/monitor'

describe('isMacScreenshotFilename', () => {
  it('matches the English default prefix', () => {
    expect(isMacScreenshotFilename('Screenshot 2026-05-01 at 12.34.56.png')).toBe(true)
  })

  it('matches localized prefixes used by stock macOS', () => {
    const cases = [
      'Bildschirmfoto 2026-05-01 um 12.34.56.png', // German (still)
      'Bildschirmaufnahme 2026-05-01.png', // German (recording — same family)
      "Capture d'écran 2026-05-01 à 12.34.56.png", // French
      "Capture d'ecran 2026-05-01.png", // French ASCII variant
      'Captura de pantalla 2026-05-01 a las 12.34.56.png', // Spanish
      'Captura de tela 2026-05-01 às 12.34.56.png', // Portuguese (BR)
      'Schermata 2026-05-01 alle 12.34.56.png', // Italian
      'Schermafbeelding 2026-05-01 om 12.34.56.png', // Dutch
      'Skärmavbild 2026-05-01 kl. 12.34.56.png', // Swedish
      'Skjermbilde 2026-05-01 kl. 12.34.56.png', // Norwegian
      'Skærmbillede 2026-05-01 kl. 12.34.56.png', // Danish
      'スクリーンショット 2026-05-01 12.34.56.png', // Japanese
      'スクリーンキャプチャ 2026-05-01 12.34.56.png', // Japanese (recording)
      '화면 캡처 2026-05-01 오전 12.34.56.png', // Korean
      'Снимок экрана 2026-05-01 в 12.34.56.png' // Russian
    ]
    for (const filename of cases) {
      expect(isMacScreenshotFilename(filename), filename).toBe(true)
    }
  })

  it('rejects non-screenshot pngs in the same dir', () => {
    expect(isMacScreenshotFilename('IMG_4321.png')).toBe(false)
    expect(isMacScreenshotFilename('vacation-photo.png')).toBe(false)
    expect(isMacScreenshotFilename('logo.png')).toBe(false)
  })

  it('rejects non-png files even if the prefix matches', () => {
    expect(isMacScreenshotFilename('Screenshot 2026-05-01.heic')).toBe(false)
    expect(isMacScreenshotFilename('Screenshot 2026-05-01.mov')).toBe(false)
  })

  it('rejects similar but wrong prefixes', () => {
    expect(isMacScreenshotFilename('Screenshots 2026-05-01.png')).toBe(false)
    expect(isMacScreenshotFilename('MyScreenshot 2026-05-01.png')).toBe(false)
  })

  it('regex export is the source of truth and matches the helper', () => {
    expect(MAC_SCREENSHOT_FILENAME_RE.test('Screenshot 2026-05-01.png')).toBe(true)
    expect(MAC_SCREENSHOT_FILENAME_RE.test('not-a-screenshot.png')).toBe(false)
  })
})

describe('generateFilename', () => {
  it('always produces a string matching SAFE_REMOTE_FILENAME_RE', () => {
    for (let i = 0; i < 25; i++) {
      const f = generateFilename()
      expect(f, f).toMatch(SAFE_REMOTE_FILENAME_RE)
    }
  })

  it('produces strictly screenshot-<ISO-stamp>.png shape', () => {
    const f = generateFilename()
    expect(f).toMatch(/^screenshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/)
  })
})

describe('SAFE_REMOTE_FILENAME_RE', () => {
  it('rejects shell-metacharacters', () => {
    const dangerous = [
      'screenshot-$(rm -rf ~).png',
      'screenshot-`whoami`.png',
      'screenshot-2026-05-01T12-00-00.png; rm -rf ~',
      'screenshot-2026-05-01T12-00-00.png && curl evil.com',
      "screenshot-' OR 1=1 --.png",
      '../../../etc/passwd',
      'screenshot.png',
      'screenshot-2026-05-01.png',
      'screenshot-2026-05-01T12-00-00.PNG'
    ]
    for (const f of dangerous) {
      expect(SAFE_REMOTE_FILENAME_RE.test(f), f).toBe(false)
    }
  })

  it('accepts the canonical generateFilename output', () => {
    expect(SAFE_REMOTE_FILENAME_RE.test('screenshot-2026-05-01T12-34-56.png')).toBe(true)
  })
})

describe('getImageHash', () => {
  it('is deterministic for the same buffer', () => {
    const buf = Buffer.from('hello world')
    expect(getImageHash(buf)).toBe(getImageHash(buf))
  })

  it('produces different hashes for different buffers', () => {
    expect(getImageHash(Buffer.from('a'))).not.toBe(getImageHash(Buffer.from('b')))
  })

  it('produces a 32-char hex string (md5)', () => {
    expect(getImageHash(Buffer.from('anything'))).toMatch(/^[0-9a-f]{32}$/)
  })

  it('handles empty buffers', () => {
    expect(getImageHash(Buffer.alloc(0))).toMatch(/^[0-9a-f]{32}$/)
  })
})
