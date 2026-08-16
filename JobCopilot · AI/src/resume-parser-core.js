(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ResumeParserCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const MAX_OCR_PAGES = 5;
  const MAX_DELIVERY_PAGES = 5;
  const MIN_LOCAL_TEXT_CHARS = 80;
  const TEXT_EXTENSIONS = Object.freeze(['txt', 'md']);
  const IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

  class ResumeParseError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ResumeParseError';
      this.code = code;
    }
  }

  function extensionOf(name) {
    const match = String(name || '').toLowerCase().match(/\.([^.]+)$/);
    return match ? match[1] : '';
  }

  function cleanExtractedText(text) {
    return String(text || '')
      .replace(/\u0000/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function meaningfulLength(text) {
    return cleanExtractedText(text).replace(/\s/g, '').length;
  }

  function validateFile(file) {
    if (!file || typeof file.name !== 'string') {
      throw new ResumeParseError('请先选择简历文件', 'missing_file');
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
      throw new ResumeParseError('简历文件为空', 'empty_file');
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new ResumeParseError('简历文件不能超过 15 MB', 'file_too_large');
    }
  }

  function fileKind(file) {
    const ext = extensionOf(file && file.name);
    const type = String(file && file.type || '').toLowerCase();
    if (TEXT_EXTENSIONS.includes(ext) || type === 'text/plain' || type === 'text/markdown') return 'text';
    if (ext === 'docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
    if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
    if (IMAGE_TYPES.includes(type) || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'image';
    return 'unsupported';
  }

  function pageItemsToText(items) {
    let output = '';
    for (const item of items || []) {
      if (!item || typeof item.str !== 'string') continue;
      output += item.str;
      output += item.hasEOL ? '\n' : ' ';
    }
    return cleanExtractedText(output);
  }

  function createParser(dependencies) {
    dependencies = dependencies || {};
    const pdfjsLib = dependencies.pdfjsLib;
    const mammoth = dependencies.mammoth;
    const documentRef = dependencies.documentRef || (typeof document !== 'undefined' ? document : null);
    const createImageBitmapImpl = dependencies.createImageBitmapImpl ||
      (typeof createImageBitmap === 'function' ? createImageBitmap.bind(globalThis) : null);

    async function parseText(file) {
      const text = cleanExtractedText(await file.text());
      if (!text) throw new ResumeParseError('文本文件中没有可用内容', 'no_text');
      return { format: extensionOf(file.name) || 'txt', text: text, needsOcr: false };
    }

    async function parseDocx(file) {
      if (!mammoth || typeof mammoth.extractRawText !== 'function') {
        throw new ResumeParseError('Word 解析组件未加载，请重新加载扩展', 'docx_parser_unavailable');
      }
      const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      const text = cleanExtractedText(result && result.value);
      if (!text) throw new ResumeParseError('Word 文件中没有提取到文字，请另存为 PDF 或 TXT 后重试', 'no_text');
      return {
        format: 'docx',
        text: text,
        needsOcr: false,
        warnings: Array.isArray(result.messages) ? result.messages.map(item => item.message).filter(Boolean) : []
      };
    }

    async function loadPdf(file) {
      if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
        throw new ResumeParseError('PDF 解析组件未加载，请重新加载扩展', 'pdf_parser_unavailable');
      }
      const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
      return loadingTask.promise;
    }

    async function parsePdf(file) {
      const pdf = await loadPdf(file);
      const pageCount = pdf.numPages;
      const pages = [];
      try {
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          const pageText = pageItemsToText(content.items);
          if (pageText) pages.push(pageText);
        }
      } finally {
        if (typeof pdf.destroy === 'function') await pdf.destroy();
      }

      const text = cleanExtractedText(pages.join('\n\n'));
      const needsOcr = meaningfulLength(text) < MIN_LOCAL_TEXT_CHARS;
      return {
        format: 'pdf',
        text: text,
        pageCount: pageCount,
        needsOcr: needsOcr,
        reason: needsOcr ? 'scanned_or_low_text_pdf' : ''
      };
    }

    async function parse(file) {
      validateFile(file);
      const kind = fileKind(file);
      if (kind === 'text') return parseText(file);
      if (kind === 'docx') return parseDocx(file);
      if (kind === 'pdf') return parsePdf(file);
      if (kind === 'image') {
        return {
          format: extensionOf(file.name) || file.type,
          text: '',
          needsOcr: true,
          reason: 'image_requires_ocr'
        };
      }
      throw new ResumeParseError('暂不支持此格式，请选择 PDF、DOCX、TXT、MD、JPG、PNG 或 WebP', 'unsupported_type');
    }

    function makeCanvas(width, height) {
      if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new ResumeParseError('当前环境无法渲染扫描件', 'canvas_unavailable');
      }
      const canvas = documentRef.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }

    async function renderPdfPages(file, options) {
      options = options || {};
      const maxPages = options.maxPages || MAX_OCR_PAGES;
      const maxDimension = options.maxDimension || 1800;
      const pdf = await loadPdf(file);
      if (pdf.numPages > maxPages) {
        if (typeof pdf.destroy === 'function') await pdf.destroy();
        const message = options.mode === 'delivery'
          ? 'PDF 最多支持生成 ' + maxPages + ' 张图片，请精简后重试'
          : '扫描版 PDF 最多支持 ' + maxPages + ' 页，请精简后重试';
        throw new ResumeParseError(message, 'too_many_pages');
      }

      const images = [];
      try {
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(
            2,
            maxDimension / Math.max(baseViewport.width, baseViewport.height)
          );
          const viewport = page.getViewport({ scale: scale });
          const canvas = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const context = canvas.getContext('2d', { alpha: false });
          await page.render({ canvasContext: context, viewport: viewport }).promise;
          images.push(canvas.toDataURL('image/jpeg', 0.88));
          canvas.width = 0;
          canvas.height = 0;
        }
      } finally {
        if (typeof pdf.destroy === 'function') await pdf.destroy();
      }
      return images;
    }

    async function renderImage(file, options) {
      options = options || {};
      if (!createImageBitmapImpl) {
        throw new ResumeParseError('当前环境无法读取图片', 'image_decoder_unavailable');
      }
      const maxDimension = options.maxDimension || 2000;
      const bitmap = await createImageBitmapImpl(file);
      try {
        const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = makeCanvas(width, height);
        const context = canvas.getContext('2d', { alpha: false });
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        canvas.width = 0;
        canvas.height = 0;
        return [dataUrl];
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close();
      }
    }

    function wrapCanvasText(context, text, maxWidth) {
      const tokens = String(text || '').match(/\s+|[A-Za-z0-9@._/+:#-]+|[\u3400-\u9FFF]|[^\s]/g) || [];
      const lines = [];
      let line = '';
      for (const token of tokens) {
        const candidate = line + token;
        if (line && context.measureText(candidate).width > maxWidth) {
          lines.push(line.trimEnd());
          line = token.trimStart();
        } else {
          line = candidate;
        }
      }
      if (line.trim()) lines.push(line.trimEnd());
      return lines.length ? lines : [''];
    }

    function textBlockStyle(rawText, isFirstContent) {
      let text = String(rawText || '').trim();
      const markdownHeading = text.match(/^(#{1,3})\s+(.+)$/);
      if (markdownHeading) text = markdownHeading[2].trim();
      const bullet = /^[-*]\s+/.test(text);
      if (bullet) text = '- ' + text.replace(/^[-*]\s+/, '');
      const heading = !isFirstContent && (
        Boolean(markdownHeading) ||
        (text.length <= 24 && /(?:教育背景|教育经历|工作经历|实习经历|项目经历|项目经验|专业技能|技能特长|个人优势|自我评价|获奖经历|校园经历|证书|联系方式)$/.test(text))
      );
      if (isFirstContent) return { text: text, font: '700 38px "Microsoft YaHei", sans-serif', color: '#182230', lineHeight: 52, before: 0, after: 18 };
      if (heading) return { text: text, font: '700 27px "Microsoft YaHei", sans-serif', color: '#0875b8', lineHeight: 40, before: 20, after: 8, heading: true };
      return { text: text, font: '22px "Microsoft YaHei", sans-serif', color: '#344054', lineHeight: 34, before: 3, after: 5 };
    }

    async function renderTextPages(text, options) {
      options = options || {};
      const normalized = cleanExtractedText(text);
      if (!normalized) throw new ResumeParseError('简历中没有可生成图片的文字', 'no_text');

      const width = options.width || 1240;
      const height = options.height || 1754;
      const marginX = options.marginX || 92;
      const marginTop = options.marginTop || 82;
      const marginBottom = options.marginBottom || 88;
      const maxPages = options.maxPages || MAX_DELIVERY_PAGES;
      const contentWidth = width - marginX * 2;
      const images = [];
      let pageNumber = 0;
      let canvas;
      let context;
      let y;

      function startPage() {
        pageNumber++;
        if (pageNumber > maxPages) {
          throw new ResumeParseError('文字简历最多支持生成 ' + maxPages + ' 张图片，请精简内容后重试', 'too_many_pages');
        }
        canvas = makeCanvas(width, height);
        context = canvas.getContext('2d', { alpha: false });
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.fillStyle = '#0ba5ec';
        context.fillRect(marginX, 48, 92, 7);
        y = marginTop;
      }

      function finishPage() {
        context.font = '18px "Microsoft YaHei", sans-serif';
        context.fillStyle = '#98a2b3';
        context.textAlign = 'right';
        context.fillText('简历 · 第 ' + pageNumber + ' 页', width - marginX, height - 40);
        context.textAlign = 'left';
        images.push(canvas.toDataURL('image/jpeg', 0.9));
        canvas.width = 0;
        canvas.height = 0;
      }

      startPage();
      let contentIndex = 0;
      const blocks = normalized.split('\n');
      for (const rawBlock of blocks) {
        if (!rawBlock.trim()) {
          y += 14;
          continue;
        }
        const style = textBlockStyle(rawBlock, contentIndex === 0);
        contentIndex++;
        context.font = style.font;
        const lines = wrapCanvasText(context, style.text, contentWidth);
        if (y + style.before + style.lineHeight + style.after > height - marginBottom) {
          finishPage();
          startPage();
          context.font = style.font;
        }
        y += style.before;
        for (const line of lines) {
          if (y + style.lineHeight + style.after > height - marginBottom) {
            finishPage();
            startPage();
            context.font = style.font;
          }
          context.fillStyle = style.color;
          context.fillText(line, marginX, y + style.lineHeight - 8);
          y += style.lineHeight;
        }
        if (style.heading) {
          context.fillStyle = '#d1e9ff';
          context.fillRect(marginX, y - 3, contentWidth, 2);
        }
        y += style.after;
      }
      finishPage();
      return images;
    }

    async function prepareOcrImages(file, options) {
      validateFile(file);
      const kind = fileKind(file);
      if (kind === 'pdf') return renderPdfPages(file, options);
      if (kind === 'image') return renderImage(file, options);
      throw new ResumeParseError('只有扫描版 PDF 或图片需要 MuskAI OCR', 'ocr_not_needed');
    }

    async function prepareDeliveryImages(file, options) {
      validateFile(file);
      const kind = fileKind(file);
      if (kind === 'pdf') {
        return renderPdfPages(file, Object.assign({
          maxPages: MAX_DELIVERY_PAGES,
          maxDimension: 1800,
          mode: 'delivery'
        }, options || {}));
      }
      if (kind === 'image') return renderImage(file, options);
      if (kind === 'docx' || kind === 'text') {
        const result = await parse(file);
        return renderTextPages(result.text, options);
      }
      throw new ResumeParseError('暂不支持将此格式生成投递图片', 'unsupported_type');
    }

    return Object.freeze({
      parse: parse,
      prepareOcrImages: prepareOcrImages,
      prepareDeliveryImages: prepareDeliveryImages
    });
  }

  return Object.freeze({
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_OCR_PAGES: MAX_OCR_PAGES,
    MAX_DELIVERY_PAGES: MAX_DELIVERY_PAGES,
    MIN_LOCAL_TEXT_CHARS: MIN_LOCAL_TEXT_CHARS,
    ResumeParseError: ResumeParseError,
    extensionOf: extensionOf,
    cleanExtractedText: cleanExtractedText,
    meaningfulLength: meaningfulLength,
    fileKind: fileKind,
    pageItemsToText: pageItemsToText,
    createParser: createParser
  });
});
