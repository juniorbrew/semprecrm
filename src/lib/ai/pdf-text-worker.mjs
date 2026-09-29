// ============================================================
// PDF text extraction worker (worker_threads). Spawned by
// knowledge-extract.ts with a heap cap and a hard timeout, so a hostile
// or huge PDF can neither freeze the server's event loop nor take its
// memory. Extracts page by page and stops as soon as the page count or
// the running text total passes the limits.
//
// in:  workerData = { bytes: Uint8Array, maxPages, maxChars }
// out: { ok: true, text } | { ok: false, code: 'invalid' | 'too_many_pages' | 'too_long' }
// ============================================================

import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';

async function run() {
  const { bytes, maxPages, maxChars } = workerData;
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch {
    return { ok: false, code: 'invalid' };
  }
  if (pdf.numPages > maxPages) return { ok: false, code: 'too_many_pages' };

  const pages = [];
  let total = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    let text;
    try {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // Separate text runs so words from different runs don't glue together.
      text = content.items
        .map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/[ \t]+/g, ' ');
      page.cleanup();
    } catch {
      return { ok: false, code: 'invalid' };
    }
    total += text.length;
    if (total > maxChars) return { ok: false, code: 'too_long' };
    pages.push(text);
  }
  return { ok: true, text: pages.join('\n\n') };
}

parentPort.postMessage(await run());
