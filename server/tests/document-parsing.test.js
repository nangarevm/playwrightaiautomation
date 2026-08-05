import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import PDFDocument from 'pdfkit';
import XLSX from 'xlsx';
import JSZip from 'jszip';
import { classifyDocument, extractDocumentText } from '../src/services/documentParsingService.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-parse-test-'));

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writePdfFixture(fileName, text) {
  const filePath = path.join(tmpDir, fileName);
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.fontSize(14).text(text);
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  return filePath;
}

// Minimal, real, valid .docx (a zip of OOXML parts) containing a single paragraph
// of the given text -- enough for mammoth.extractRawText to parse for real.
async function writeDocxFixture(fileName, text) {
  const filePath = path.join(tmpDir, fileName);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function writeXlsxFixture(fileName, rows) {
  const filePath = path.join(tmpDir, fileName);
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

test('classifyDocument recognizes PDF/Word/Excel by extension and mime type', () => {
  assert.equal(classifyDocument('requirements.pdf', 'application/pdf'), 'pdf');
  assert.equal(classifyDocument('spec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
  assert.equal(classifyDocument('data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx');
  assert.equal(classifyDocument('legacy.xls', 'application/vnd.ms-excel'), 'xlsx');
  assert.equal(classifyDocument('notes.txt', 'text/plain'), 'unsupported');
});

test('extractDocumentText parses real text out of a PDF (FR-1.7)', async (t) => {
  const filePath = await writePdfFixture('sample.pdf', 'Login page must accept a username and password and redirect to the dashboard.');
  const result = await extractDocumentText(filePath, 'sample.pdf', 'application/pdf');
  assert.equal(result.status, 'parsed');
  assert.equal(result.kind, 'pdf');
  assert.match(result.text, /username and password/);
});

test('extractDocumentText parses real text out of a .docx (FR-1.7)', async (t) => {
  const filePath = await writeDocxFixture('sample.docx', 'The checkout flow must validate the promo code before charging the card.');
  const result = await extractDocumentText(
    filePath,
    'sample.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  assert.equal(result.status, 'parsed');
  assert.equal(result.kind, 'docx');
  assert.match(result.text, /checkout flow/);
});

test('extractDocumentText parses real cell data out of an .xlsx (FR-1.7)', async (t) => {
  const filePath = writeXlsxFixture('sample.xlsx', [
    ['Scenario', 'Expected'],
    ['Invalid login', 'Show inline error'],
  ]);
  const result = await extractDocumentText(
    filePath,
    'sample.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  assert.equal(result.status, 'parsed');
  assert.equal(result.kind, 'xlsx');
  assert.match(result.text, /Invalid login/);
  assert.match(result.text, /Show inline error/);
});

test('extractDocumentText fails gracefully (not a crash) for an unsupported extension (FR-1.9)', async (t) => {
  const filePath = path.join(tmpDir, 'notes.txt');
  fs.writeFileSync(filePath, 'plain text file');
  const result = await extractDocumentText(filePath, 'notes.txt', 'text/plain');
  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'unsupported');
  assert.match(result.error, /Unsupported document format/);
});

test('extractDocumentText fails gracefully (not a crash) for a corrupted PDF (FR-1.9)', async (t) => {
  const filePath = path.join(tmpDir, 'corrupted.pdf');
  fs.writeFileSync(filePath, 'this is not really a pdf file, just garbage bytes %%%%');
  const result = await extractDocumentText(filePath, 'corrupted.pdf', 'application/pdf');
  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'pdf');
  assert.match(result.error, /corrupted or is not a valid/);
});

test('extractDocumentText fails gracefully (not a crash) for a corrupted .docx (FR-1.9)', async (t) => {
  const filePath = path.join(tmpDir, 'corrupted.docx');
  fs.writeFileSync(filePath, 'this is not really a docx file, just garbage bytes %%%%');
  const result = await extractDocumentText(
    filePath,
    'corrupted.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'docx');
  assert.match(result.error, /corrupted or is not a valid/);
});

test('extractDocumentText reports empty documents as failed rather than an empty success (FR-1.9)', async (t) => {
  const filePath = await writeDocxFixture('empty.docx', '');
  const result = await extractDocumentText(
    filePath,
    'empty.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /No extractable text/);
});
