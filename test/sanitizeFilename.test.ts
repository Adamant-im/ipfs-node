import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sanitizeFilename } from '../src/utils/sanitizeFilename.js'

describe('sanitizeFilename', () => {
  it('removes traversal, separators, control characters, and formatting marks', () => {
    assert.equal(sanitizeFilename('../folder\\evil\n\u202efile.txt'), '_folder_evilfile.txt')
  })

  it('uses a safe fallback for an empty filename', () => {
    assert.equal(sanitizeFilename('../..'), 'unnamed')
  })

  it('never splits UTF-8 characters or exceeds 255 bytes', () => {
    const value = sanitizeFilename('🙂'.repeat(100))
    assert.ok(Buffer.byteLength(value, 'utf8') <= 255)
    assert.equal(value.includes('\ufffd'), false)
  })
})
