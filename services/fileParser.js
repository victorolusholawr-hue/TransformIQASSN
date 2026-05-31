'use strict';
const fs   = require('fs');
const path = require('path');

/**
 * Parse an uploaded file and return { text, metadata }.
 * metadata = { word_count, page_count, extraction_method }
 */
async function parseFile(filePath, ext) {
  const e = (ext || '').toLowerCase().replace('.', '');

  switch (e) {
    case 'pdf':  return parsePdf(filePath);
    case 'docx': return parseDocx(filePath);
    case 'xlsx':
    case 'xls':  return parseXlsx(filePath);
    case 'txt':  return parseTxt(filePath);
    case 'pptx': return parsePptx(filePath);
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':  return parseImage(filePath);
    default:
      return { text: '', metadata: { extraction_method: 'unsupported', word_count: 0 } };
  }
}

async function parsePdf(filePath) {
  const pdfParse = require('pdf-parse');
  const buffer   = fs.readFileSync(filePath);
  const data     = await pdfParse(buffer);
  return {
    text: data.text || '',
    metadata: {
      extraction_method: 'pdf-parse',
      word_count:  countWords(data.text),
      page_count:  data.numpages || 0,
    },
  };
}

async function parseDocx(filePath) {
  const mammoth  = require('mammoth');
  const result   = await mammoth.extractRawText({ path: filePath });
  return {
    text: result.value || '',
    metadata: {
      extraction_method: 'mammoth',
      word_count: countWords(result.value),
    },
  };
}

async function parseXlsx(filePath) {
  const XLSX  = require('xlsx');
  const wb    = XLSX.readFile(filePath);
  const parts = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const rows  = XLSX.utils.sheet_to_csv(sheet);
    parts.push(`Sheet: ${name}\n${rows}`);
  }
  const text = parts.join('\n\n');
  return {
    text,
    metadata: { extraction_method: 'xlsx', word_count: countWords(text) },
  };
}

async function parseTxt(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return {
    text,
    metadata: { extraction_method: 'plain-text', word_count: countWords(text) },
  };
}

async function parsePptx(filePath) {
  // Basic PPTX text extraction via XML parsing (no native npm package needed)
  try {
    const AdmZip    = require('adm-zip');
    const zip       = new AdmZip(filePath);
    const entries   = zip.getEntries().filter(e => /ppt\/slides\/slide\d+\.xml/.test(e.entryName));
    const texts     = [];
    for (const entry of entries) {
      const xml  = entry.getData().toString('utf8');
      const bits = xml.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) || [];
      texts.push(bits.map(b => b.replace(/<[^>]+>/g, '')).join(' '));
    }
    const text = texts.join('\n');
    return { text, metadata: { extraction_method: 'pptx-xml', word_count: countWords(text) } };
  } catch (_) {
    return { text: '', metadata: { extraction_method: 'pptx-failed', word_count: 0 } };
  }
}

async function parseImage(filePath) {
  try {
    const Tesseract = require('tesseract.js');
    const { data }  = await Tesseract.recognize(filePath, 'eng');
    const text      = data.text || '';
    const wordCount = countWords(text);
    // If < 20 words, flag for Claude Vision fallback
    return {
      text,
      metadata: {
        extraction_method: wordCount < 20 ? 'ocr-needs-vision' : 'tesseract-ocr',
        word_count: wordCount,
      },
    };
  } catch (_) {
    return { text: '', metadata: { extraction_method: 'ocr-needs-vision', word_count: 0 } };
  }
}

/**
 * Claude Vision fallback — used when Tesseract yields < 20 words.
 * Returns extracted text string.
 */
async function parseImageWithVision(imageUrl) {
  const { callClaude, ANTHROPIC_MODEL } = require('./ai');

  let imageSource;
  if (imageUrl.startsWith('http')) {
    imageSource = { type: 'url', url: imageUrl };
  } else {
    const localPath = imageUrl.startsWith('/')
      ? path.join(__dirname, '..', 'public', imageUrl.replace(/^\//, ''))
      : imageUrl;
    const buf    = fs.readFileSync(localPath);
    const b64    = buf.toString('base64');
    const ext    = path.extname(localPath).toLowerCase().replace('.', '');
    const mt     = ext === 'jpg' ? 'jpeg' : ext;
    imageSource  = { type: 'base64', media_type: `image/${mt}`, data: b64 };
  }

  const response = await callClaude(
    [{
      role: 'user',
      content: [
        { type: 'image', source: imageSource },
        {
          type: 'text',
          text: (
            'Extract all content from this image for business analysis. ' +
            'Transcribe any visible text in full. For diagrams, flowcharts, or process maps: ' +
            'describe each step, decision point, and relationship in structured prose. ' +
            'For tables or data: reproduce the structure and all values. ' +
            'For org charts: list all roles and reporting relationships. ' +
            'Output only the extracted content with no commentary.'
          ),
        },
      ],
    }],
    `You are a precise image transcription and business-analysis assistant. Use the configured Claude model ${ANTHROPIC_MODEL}.`,
    4096
  );
  return response.content[0].text || '';
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

module.exports = { parseFile, parseImageWithVision, countWords };
