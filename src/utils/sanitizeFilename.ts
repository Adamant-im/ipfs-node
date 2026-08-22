/**
 * Sanitizes a filename from multipart Content-Disposition header.
 */
export function sanitizeFilename(raw: string): string {
  let name = raw.normalize('NFKC')

  // Strip control and formatting characters to prevent path and log injection.
  /* eslint-disable no-control-regex */
  name = name.replace(/[\x00-\x1f\x7f]/g, '')
  /* eslint-enable no-control-regex */
  name = name.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
  name = name.replace(/[/\\]/g, '_')
  name = name.replace(/\.\.+/g, '')
  name = name.replace(/^[. ]+|[. ]+$/g, '')

  let result = ''
  for (const character of name) {
    if (Buffer.byteLength(result + character, 'utf8') > 255) {
      break
    }
    result += character
  }

  return result && !/^[._ -]+$/.test(result) ? result : 'unnamed'
}
