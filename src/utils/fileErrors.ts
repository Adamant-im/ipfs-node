/** Error raised when an IPFS file cannot be retrieved within the configured timeout. */
export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileNotFoundError'
  }
}
