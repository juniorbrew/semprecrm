// ============================================================
// Knowledge base — text extraction from uploaded files (server only).
// .txt/.md/.csv are decoded as UTF-8 (falling back to Windows-1252,
// common for spreadsheets exported in Brazil) after a "does this look
// like text?" check; .pdf goes through unpdf (PDF.js) in a
// worker_threads Worker with a heap cap and a hard timeout, so a heavy
// or hostile PDF cannot freeze the server or eat its memory. Only the
// text is kept, never the binary.
// ============================================================

import { Worker } from 'node:worker_threads';

import { cleanText, KB_FILE_EXTENSIONS, KB_LIMITS } from './knowledge';

export const KB_EXTRACT_ERRORS = {
  type: 'Unsupported file type. Send a .txt, .md, .csv or .pdf file.',
  size: 'The file is too large (maximum 5 MB).',
  empty: 'The file has no text.',
  notText: 'This file does not look like text. Send a plain-text .txt, .md or .csv file.',
  tooLong: 'The file has too much text (maximum 200,000 characters). Split it into smaller files.',
  pdfNoText:
    'This PDF has no selectable text (it looks scanned). Send a PDF with text, or paste the content as a text item.',
  pdfInvalid: 'Could not read this PDF. It may be damaged or password-protected.',
  pdfTooManyPages: 'This PDF has too many pages (maximum 300). Split it into smaller files.',
  pdfTooHeavy: 'This PDF is too heavy to read. Split it into smaller files or paste the text as a text item.',
  pdfTimeout: 'Reading this PDF took too long. Split it into smaller files or paste the text as a text item.',
} as const;

export const PDF_LIMITS = {
  maxPages: 300,
  timeoutMs: 15_000,
  heapMb: 256,
} as const;

export class KbExtractError extends Error {}

export function fileExtension(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** Share of characters that are control / replacement chars — binary files score high. */
function junkRatio(text: string): number {
  if (!text) return 0;
  const junk = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F�]/g)?.length ?? 0;
  return junk / text.length;
}

function decodeText(bytes: Uint8Array): string {
  // NUL bytes never appear in UTF-8/CP-1252 text (UTF-16, images, zips…).
  if (bytes.includes(0)) throw new KbExtractError(KB_EXTRACT_ERRORS.notText);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  if (junkRatio(text) > 0.1) throw new KbExtractError(KB_EXTRACT_ERRORS.notText);
  return text;
}

type WorkerFailure = 'invalid' | 'too_many_pages' | 'too_long';
type WorkerReply = { ok: true; text: string } | { ok: false; code: WorkerFailure };

const WORKER_ERRORS: Record<WorkerFailure, string> = {
  invalid: KB_EXTRACT_ERRORS.pdfInvalid,
  too_many_pages: KB_EXTRACT_ERRORS.pdfTooManyPages,
  too_long: KB_EXTRACT_ERRORS.tooLong,
};

/** Extract PDF text in an isolated, memory-capped, time-limited worker. */
export function pdfTextInWorker(
  bytes: Uint8Array,
  limits: Partial<Record<keyof typeof PDF_LIMITS, number>> = {},
): Promise<string> {
  const { maxPages, timeoutMs, heapMb } = { ...PDF_LIMITS, ...limits };
  return new Promise((resolve, reject) => {
    const copy = bytes.slice();
    const worker = new Worker(new URL('./pdf-text-worker.mjs', import.meta.url), {
      workerData: { bytes: copy, maxPages, maxChars: KB_LIMITS.fileContentMaxChars },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 32 },
    });
    let settled = false;
    const finish = (err: string | null, text = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (err) reject(new KbExtractError(err));
      else resolve(text);
    };
    const timer = setTimeout(() => finish(KB_EXTRACT_ERRORS.pdfTimeout), timeoutMs);
    worker.once('message', (msg: WorkerReply) => (msg.ok ? finish(null, msg.text) : finish(WORKER_ERRORS[msg.code])));
    worker.once('error', (err: Error & { code?: string }) => {
      if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') return finish(KB_EXTRACT_ERRORS.pdfTooHeavy);
      console.error('[kb] pdf worker failed:', err.message);
      finish(KB_EXTRACT_ERRORS.pdfInvalid);
    });
    worker.once('exit', () => finish(KB_EXTRACT_ERRORS.pdfTooHeavy));
  });
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const text = await pdfTextInWorker(bytes);
  // Scanned PDFs come back empty (or with a few stray glyphs).
  if (text.replace(/\s+/g, '').length < 20) throw new KbExtractError(KB_EXTRACT_ERRORS.pdfNoText);
  return text;
}

/** Extract plain text from an uploaded file; throws KbExtractError with a user-facing message. */
export async function extractFileText(name: string, bytes: Uint8Array): Promise<string> {
  const ext = fileExtension(name);
  if (!(KB_FILE_EXTENSIONS as readonly string[]).includes(ext)) throw new KbExtractError(KB_EXTRACT_ERRORS.type);
  if (bytes.byteLength > KB_LIMITS.fileMaxBytes) throw new KbExtractError(KB_EXTRACT_ERRORS.size);

  const raw = ext === 'pdf' ? await pdfText(bytes) : decodeText(bytes);
  const text = cleanText(raw);
  if (!text) throw new KbExtractError(KB_EXTRACT_ERRORS.empty);
  if (text.length > KB_LIMITS.fileContentMaxChars) throw new KbExtractError(KB_EXTRACT_ERRORS.tooLong);
  return text;
}
