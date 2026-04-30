/**
 * Sanitizes a filename from multipart Content-Disposition header.
 */
export function sanitizeFilename(raw: string): string {
  let name = raw

  // 1. Normalize Unicode — collapse homoglyphs, remove zero-width chars
  name = name.normalize('NFKC')

  // 2. Strip null bytes — terminate strings in C libs prematurely
  // eslint-disable-next-line no-control-regex
  name = name.replace(/\x00/g, '')

  // 3. Strip control characters including \n, \r, \t — prevent log injection
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f\x7f]/g, '')

  // 4. Strip path separators and traversal sequences
  name = name.replace(/[/\\]/g, '_')
  name = name.replace(/\.\.+/g, '')

  // 5. Enforce max length — 255 bytes is POSIX limit for filename
  if (Buffer.byteLength(name, 'utf8') > 255) {
    const buf = Buffer.from(name, 'utf8').subarray(0, 255)
    name = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  }

  // 6. Fallback for empty result after sanitization
  if (!name.trim()) {
    name = 'unnamed'
  }

  return name
}
