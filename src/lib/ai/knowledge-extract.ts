// ============================================================
// Knowledge base — text extraction from uploaded files (server only).
// .txt/.md/.csv are decoded as UTF-8 (falling back to Windows-1252,
// common for spreadsheets exported in Brazil); .pdf goes through unpdf
// (PDF.js serverless build). Only the text is kept, never the binary.
// ============================================================

import { cleanText, KB_FILE_EXTENSIONS, KB_LIMITS } from './knowledge';

export const KB_EXTRACT_ERRORS = {
  type: 'Unsupported file type. Send a .txt, .md, .csv or .pdf file.',
  size: 'The file is too large (maximum 5 MB).',
  empty: 'The file has no text.',
  tooLong: 'The file has too much text (maximum 200,000 characters). Split it into smaller files.',
  pdfNoText:
    'This PDF has no selectable text (it looks scanned). Send a PDF with text, or paste the content as a text item.',
  pdfInvalid: 'Could not read this PDF. It may be damaged or password-protected.',
} as const;

export class KbExtractError extends Error {}

export function fileExtension(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  let text: string;
  try {
    const pdf = await getDocumentProxy(bytes);
    ({ text } = await extractText(pdf, { mergePages: true }));
  } catch {
    throw new KbExtractError(KB_EXTRACT_ERRORS.pdfInvalid);
  }
  // Scanned PDFs come back empty (or with a few stray glyphs).
  if (text.replace(/\s+/g, '').length < 20) throw new KbExtractError(KB_EXTRACT_ERRORS.pdfNoText);
  return text;
}

/** Extract plain text from an uploaded file; throws KbExtractError with a user-facing message. */
export async function extractFileText(name: string, bytes: Uint8Array): Promise<string> {
  const ext = fileExtension(name);
  if (!(KB_FILE_EXTENSIONS as readonly string[]).includes(ext)) throw new KbExtractError(KB_EXTRACT_ERRORS.type);
  if (bytes.byteLength > KB_LIMITS.fileMaxBytes) throw new KbExtractError(KB_EXTRACT_ERRORS.size);

  // pdf.js may detach the buffer it is given — hand it a copy.
  const raw = ext === 'pdf' ? await pdfText(bytes.slice()) : decodeText(bytes);
  const text = cleanText(raw);
  if (!text) throw new KbExtractError(KB_EXTRACT_ERRORS.empty);
  if (text.length > KB_LIMITS.fileContentMaxChars) throw new KbExtractError(KB_EXTRACT_ERRORS.tooLong);
  return text;
}
