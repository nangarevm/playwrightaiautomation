import fs from "fs";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import XLSX from "xlsx";

// FR-1.7/FR-1.9: real text extraction for uploaded PDF/Word/Excel documents, so
// this input type feeds the same generation pipeline as free-text/URL-crawl
// inputs instead of only being a placeholder telling the user to paste text
// elsewhere. Every parse failure (unsupported extension, corrupted file, empty
// document) is returned as a clear, structured result rather than thrown as an
// uncaught exception -- the caller decides how to surface it (FR-1.9).

export type DocumentKind = "pdf" | "docx" | "xlsx" | "unsupported";

export function classifyDocument(fileName: string, mimeType: string): DocumentKind {
  const lower = `${fileName || ""}`.toLowerCase();
  const mime = `${mimeType || ""}`.toLowerCase();
  if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (lower.endsWith(".docx") || mime.includes("wordprocessingml.document")) return "docx";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || mime.includes("spreadsheetml") || mime === "application/vnd.ms-excel") return "xlsx";
  return "unsupported";
}

export interface DocumentParseResult {
  status: "parsed" | "failed";
  text: string;
  error?: string;
  kind: DocumentKind;
}

async function extractPdfText(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return (result.text || "").trim();
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return (result.value || "").trim();
}

function extractXlsxText(filePath: string): string {
  const workbook = XLSX.readFile(filePath);
  const parts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet).trim();
    if (csv) parts.push(`Sheet: ${sheetName}\n${csv}`);
  }
  return parts.join("\n\n").trim();
}

// FR-1.9: corrupted/unsupported documents produce a clear, per-file error
// rather than crashing the whole batch upload request.
export async function extractDocumentText(filePath: string, fileName: string, mimeType: string): Promise<DocumentParseResult> {
  const kind = classifyDocument(fileName, mimeType);

  if (kind === "unsupported") {
    return {
      status: "failed",
      text: "",
      kind,
      error: `Unsupported document format: "${fileName}". Only PDF, Word (.docx), and Excel (.xlsx/.xls) files are accepted.`,
    };
  }

  try {
    let text = "";
    if (kind === "pdf") text = await extractPdfText(filePath);
    else if (kind === "docx") text = await extractDocxText(filePath);
    else if (kind === "xlsx") text = extractXlsxText(filePath);

    if (!text) {
      return {
        status: "failed",
        text: "",
        kind,
        error: `No extractable text found in "${fileName}" -- it may be empty, image-only (scanned without OCR), or password-protected.`,
      };
    }

    return { status: "parsed", text, kind };
  } catch (error: any) {
    return {
      status: "failed",
      text: "",
      kind,
      error: `Failed to parse "${fileName}": the file appears to be corrupted or is not a valid ${kind.toUpperCase()} file.`,
    };
  }
}
