import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');

globalThis.resumeParser = globalThis.ResumeParserCore.createParser({
  pdfjsLib: pdfjsLib,
  mammoth: globalThis.mammoth,
  documentRef: document,
  createImageBitmapImpl: typeof globalThis.createImageBitmap === 'function'
    ? globalThis.createImageBitmap.bind(globalThis)
    : null
});

globalThis.dispatchEvent(new CustomEvent('resume-parser-ready'));
