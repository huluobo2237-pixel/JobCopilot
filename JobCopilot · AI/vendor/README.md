# Vendored resume parsing libraries

These files are included locally so the unpacked Manifest V3 extension can parse resumes without loading executable code from a CDN.

- `pdf.min.mjs` and `pdf.worker.min.mjs`: PDF.js (`pdfjs-dist` 6.1.200), Apache-2.0. See `pdfjs-LICENSE`.
- `mammoth.browser.min.js`: Mammoth.js 1.12.0, BSD-2-Clause. See `mammoth-LICENSE`.

Regenerate these assets from the pinned npm dependencies with:

```bash
npm install
npm run build:vendor
```
