// Patch pdf-parse to remove its debug block that reads a non-existent
// test/data/05-versions-space.pdf at module load time. The debug block
// only runs when module.parent is falsy, which happens when pdf-parse is
// loaded via ESM interop (file2md uses `import pdfParse from 'pdf-parse'`).
//
// This script is invoked by the package.json postinstall hook so the
// patch survives `npm install` / `npm ci` without needing patch-package.
import fs from 'node:fs'
import path from 'node:path'

const targetPath = path.resolve('node_modules/pdf-parse/index.js')

if (!fs.existsSync(targetPath)) {
  console.log('[patch-pdf-parse] skipped: pdf-parse not installed')
  process.exit(0)
}

const original = fs.readFileSync(targetPath, 'utf8')

const patched = `const Fs = require('fs');
const Pdf = require('./lib/pdf-parse.js');

module.exports = Pdf;
`

if (original.includes('isDebugMode') || original.includes('05-versions-space.pdf')) {
  fs.writeFileSync(targetPath, patched, 'utf8')
  console.log('[patch-pdf-parse] patched: removed debug block from pdf-parse/index.js')
} else {
  console.log('[patch-pdf-parse] already patched, no change')
}
