export type TrustProxySetting = false | number | string | string[]

/**
 * Validate the Express trust-proxy setting without permitting the unsafe
 * blanket value `true`.
 *
 * @param value configured proxy hops, addresses, or named subnet ranges
 * @returns a value accepted by Express `app.set('trust proxy', value)`
 */
export function parseTrustProxy(value: unknown): TrustProxySetting {
  if (value === undefined || value === false) {
    return false
  }

  if (value === true) {
    throw new Error('trustProxy=true is not allowed; configure exact proxy addresses or hop count')
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('trustProxy hop count must be a positive integer')
    }
    return value
  }

  if (typeof value === 'string') {
    return validateAddress(value)
  }

  if (Array.isArray(value) && value.length > 0) {
    return value.map(validateAddress)
  }

  throw new Error('trustProxy must be false, a hop count, an address, or an address array')
}

function validateAddress(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('trustProxy addresses must be non-empty strings without surrounding whitespace')
  }
  if (['*', '0.0.0.0/0', '::/0'].includes(value) || value.includes(',')) {
    throw new Error('trustProxy must not trust every address or use comma-separated values')
  }
  return value
}
