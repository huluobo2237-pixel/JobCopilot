import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(repoRoot, 'JobCopilot · AI', 'vendor');
const nodeModules = join(repoRoot, 'node_modules');

await mkdir(vendorDir, { recursive: true });

const files = [
  ['pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs', false],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs', false],
  ['pdfjs-dist/LICENSE', 'pdfjs-LICENSE', true],
  ['mammoth/mammoth.browser.min.js', 'mammoth.browser.min.js', false],
  ['mammoth/LICENSE', 'mammoth-LICENSE', true]
];

for (const [source, target, normalizeText] of files) {
  const sourcePath = join(nodeModules, source);
  const targetPath = join(vendorDir, target);
  if (normalizeText) {
    const text = await readFile(sourcePath, 'utf8');
    await writeFile(targetPath, text.replace(/[ \t]+$/gm, ''), 'utf8');
  } else {
    await copyFile(sourcePath, targetPath);
  }
}

console.log(`Vendored ${files.length} resume parsing assets into ${vendorDir}`);
