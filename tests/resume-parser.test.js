'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_FILE_BYTES,
  cleanExtractedText,
  fileKind,
  pageItemsToText,
  createParser
} = require('../JobCopilot · AI/src/resume-parser-core.js');

function fakeFile(name, content, type) {
  const buffer = Buffer.from(content || '');
  return {
    name: name,
    type: type || '',
    size: buffer.length,
    text: async () => buffer.toString('utf8'),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  };
}

function fakePdfDocument(pageItems) {
  let destroyed = false;
  return {
    numPages: pageItems.length,
    getPage: async pageNumber => ({
      getTextContent: async () => ({ items: pageItems[pageNumber - 1] }),
      getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
      render: () => ({ promise: Promise.resolve() })
    }),
    destroy: async () => { destroyed = true; },
    wasDestroyed: () => destroyed
  };
}

function fakeCanvasDocument(drawnText) {
  let canvasCount = 0;
  return {
    createElement: () => {
      const id = ++canvasCount;
      const context = {
        fillStyle: '',
        font: '',
        textAlign: 'left',
        fillRect: () => {},
        drawImage: () => {},
        measureText: text => ({ width: String(text).length * 18 }),
        fillText: text => drawnText.push(String(text))
      };
      return {
        width: 0,
        height: 0,
        getContext: () => context,
        toDataURL: () => 'data:image/jpeg;base64,cGFnZS0' + id
      };
    }
  };
}

test('normalizes locally extracted resume text', () => {
  assert.equal(
    cleanExtractedText('\uFEFF姓名  张三  \r\n\r\n\r\n技能：JavaScript\u0000  \n'),
    '姓名 张三\n\n技能：JavaScript'
  );
  assert.equal(
    pageItemsToText([
      { str: '教育经历', hasEOL: true },
      { str: '某大学', hasEOL: false },
      { str: '计算机专业', hasEOL: true }
    ]),
    '教育经历\n某大学 计算机专业'
  );
});

test('recognizes every supported resume file type', () => {
  assert.equal(fileKind({ name: 'resume.txt', type: '' }), 'text');
  assert.equal(fileKind({ name: 'resume.md', type: '' }), 'text');
  assert.equal(fileKind({ name: 'resume.docx', type: '' }), 'docx');
  assert.equal(fileKind({ name: 'resume.pdf', type: '' }), 'pdf');
  assert.equal(fileKind({ name: 'resume.png', type: 'image/png' }), 'image');
  assert.equal(fileKind({ name: 'resume.doc', type: 'application/msword' }), 'unsupported');
});

test('parses TXT and Markdown entirely locally', async () => {
  const parser = createParser();
  const result = await parser.parse(fakeFile(
    'resume.md',
    '# 张三\r\n\r\n\r\n## 技能\r\nJavaScript  TypeScript',
    'text/markdown'
  ));
  assert.equal(result.needsOcr, false);
  assert.match(result.text, /张三/);
  assert.match(result.text, /JavaScript TypeScript/);
});

test('uses Mammoth raw text extraction for DOCX files', async () => {
  let receivedArrayBuffer = false;
  const parser = createParser({
    mammoth: {
      extractRawText: async options => {
        receivedArrayBuffer = options.arrayBuffer instanceof ArrayBuffer;
        return {
          value: '张三\n\n教育经历\n某大学\n项目经历\n完成浏览器扩展开发',
          messages: [{ message: 'test warning' }]
        };
      }
    }
  });
  const result = await parser.parse(fakeFile(
    'resume.docx',
    'fake zip bytes',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ));
  assert.equal(receivedArrayBuffer, true);
  assert.equal(result.needsOcr, false);
  assert.equal(result.warnings[0], 'test warning');
  assert.match(result.text, /浏览器扩展开发/);
});

test('extracts text PDF pages locally and destroys the PDF document', async () => {
  const longLine = '张三 软件工程师，熟悉 JavaScript、TypeScript、Chrome Extension，拥有项目开发经验。';
  const pdf = fakePdfDocument([
    [{ str: longLine, hasEOL: true }],
    [{ str: longLine + ' 负责自动化测试与发布流程。', hasEOL: true }]
  ]);
  const parser = createParser({
    pdfjsLib: { getDocument: () => ({ promise: Promise.resolve(pdf) }) }
  });
  const result = await parser.parse(fakeFile('resume.pdf', 'pdf', 'application/pdf'));
  assert.equal(result.needsOcr, false);
  assert.equal(result.pageCount, 2);
  assert.match(result.text, /自动化测试/);
  assert.equal(pdf.wasDestroyed(), true);
});

test('detects a scanned or low-text PDF without uploading it', async () => {
  const pdf = fakePdfDocument([[{ str: '', hasEOL: true }]]);
  const parser = createParser({
    pdfjsLib: { getDocument: () => ({ promise: Promise.resolve(pdf) }) }
  });
  const result = await parser.parse(fakeFile('scan.pdf', 'pdf', 'application/pdf'));
  assert.equal(result.needsOcr, true);
  assert.equal(result.reason, 'scanned_or_low_text_pdf');
  assert.equal(result.text, '');
});

test('marks image resumes as opt-in OCR without decoding or uploading them', async () => {
  let decoded = false;
  const parser = createParser({
    createImageBitmapImpl: async () => {
      decoded = true;
      throw new Error('should not run during local parse');
    }
  });
  const result = await parser.parse(fakeFile('resume.png', 'image bytes', 'image/png'));
  assert.equal(result.needsOcr, true);
  assert.equal(result.reason, 'image_requires_ocr');
  assert.equal(decoded, false);
});

test('renders an image only when prepareOcrImages is explicitly called', async () => {
  const canvases = [];
  let closed = false;
  const parser = createParser({
    documentRef: {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({
            fillStyle: '',
            fillRect: () => {},
            drawImage: () => {}
          }),
          toDataURL: () => 'data:image/jpeg;base64,b2Ny'
        };
        canvases.push(canvas);
        return canvas;
      }
    },
    createImageBitmapImpl: async () => ({
      width: 4000,
      height: 2000,
      close: () => { closed = true; }
    })
  });

  const images = await parser.prepareOcrImages(
    fakeFile('resume.png', 'image bytes', 'image/png')
  );
  assert.deepEqual(images, ['data:image/jpeg;base64,b2Ny']);
  assert.equal(closed, true);
  assert.equal(canvases.length, 1);
});

test('limits scanned PDF OCR to five pages', async () => {
  const pdf = fakePdfDocument([[], [], [], [], [], []]);
  const parser = createParser({
    pdfjsLib: { getDocument: () => ({ promise: Promise.resolve(pdf) }) }
  });
  await assert.rejects(
    parser.prepareOcrImages(fakeFile('scan.pdf', 'pdf', 'application/pdf')),
    error => error.code === 'too_many_pages' && /最多支持 5 页/.test(error.message)
  );
  assert.equal(pdf.wasDestroyed(), true);
});

test('renders every PDF resume page locally as delivery images', async () => {
  const pdf = fakePdfDocument([[], []]);
  const parser = createParser({
    pdfjsLib: { getDocument: () => ({ promise: Promise.resolve(pdf) }) },
    documentRef: fakeCanvasDocument([])
  });
  const images = await parser.prepareDeliveryImages(
    fakeFile('resume.pdf', 'pdf', 'application/pdf')
  );
  assert.equal(images.length, 2);
  assert.ok(images.every(image => image.startsWith('data:image/jpeg;base64,')));
  assert.equal(pdf.wasDestroyed(), true);
});

test('lays out TXT and DOCX resume text into local A4-style delivery images', async () => {
  const drawnText = [];
  const parser = createParser({
    documentRef: fakeCanvasDocument(drawnText),
    mammoth: {
      extractRawText: async () => ({
        value: '张三\n教育经历\n某大学 软件工程\n项目经历\n开发 JobCopilot 浏览器扩展',
        messages: []
      })
    }
  });
  const textImages = await parser.prepareDeliveryImages(
    fakeFile('resume.txt', '张三\n专业技能\nJavaScript TypeScript', 'text/plain')
  );
  const docxImages = await parser.prepareDeliveryImages(
    fakeFile('resume.docx', 'fake docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  );
  assert.equal(textImages.length, 1);
  assert.equal(docxImages.length, 1);
  assert.ok(drawnText.some(text => text.includes('张三')));
  assert.ok(drawnText.some(text => text.includes('JobCopilot')));
  assert.ok(drawnText.some(text => text.includes('JavaScript TypeScript')));
  assert.ok(drawnText.some(text => text.includes('第 1 页')));
});

test('rejects unsupported and oversized files before parsing', async () => {
  const parser = createParser();
  await assert.rejects(
    parser.parse(fakeFile('resume.doc', 'legacy doc', 'application/msword')),
    error => error.code === 'unsupported_type'
  );
  await assert.rejects(
    parser.parse({
      name: 'large.pdf',
      type: 'application/pdf',
      size: MAX_FILE_BYTES + 1
    }),
    error => error.code === 'file_too_large'
  );
});
