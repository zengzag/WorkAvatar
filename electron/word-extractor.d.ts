declare module 'word-extractor' {
  interface DocumentOptions {
    filterUnicode?: boolean
    includeFooters?: boolean
    includeHeadersAndFooters?: boolean
    includeBody?: boolean
  }

  class Document {
    getBody(options?: DocumentOptions): string
    getFootnotes(options?: DocumentOptions): string
    getEndnotes(options?: DocumentOptions): string
    getHeaders(options?: DocumentOptions): string
    getFooters(options?: DocumentOptions): string
    getAnnotations(options?: DocumentOptions): string
    getTextboxes(options?: DocumentOptions): string
  }

  class WordExtractor {
    extract(source: string | Buffer): Promise<Document>
  }

  export default WordExtractor
}
