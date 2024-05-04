declare module 'multer' {
  import { ReadStream } from 'node:fs'

  class Multer {
    array(fieldName: string, maxFileCount: number)
  }
  namespace Multer {
    export interface File {
      fieldName: string
      originalName: string
      size: number
      stream: ReadStream
      detectedMimeType: string
      detectedFileExtension: string
      clientReportedMimeType: string
      clientReportedFileExtension: string
    }
  }
  export default function multer(options: {}): Multer
}
