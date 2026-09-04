import {copyFile,mkdir} from 'node:fs/promises'
await mkdir('public/vendor',{recursive:true})
await copyFile('node_modules/@embedpdf/pdfium/dist/pdfium.wasm','public/vendor/pdfium.wasm')
