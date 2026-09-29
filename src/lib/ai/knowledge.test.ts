import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  chunksForItem,
  chunkText,
  cleanText,
  faqChunk,
  kbQueryFromMessages,
  KB_ERRORS,
  KB_LIMITS,
  parseKbItemInput,
  selectKbHits,
  sliceChars,
} from './knowledge';
import { extractFileText, KB_EXTRACT_ERRORS, pdfTextInWorker } from './knowledge-extract';

const para = (n: number, word = 'palavra') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ') + '.';

describe('chunkText', () => {
  it('keeps a short text as one chunk', () => {
    expect(chunkText('  Olá\r\n\r\n\r\nmundo  ')).toEqual(['Olá\n\nmundo']);
    expect(chunkText('   ')).toEqual([]);
  });

  it('packs paragraphs into ~target chunks within max + overlap', () => {
    const text = Array.from({ length: 12 }, (_, i) => para(40, `p${i}w`)).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(KB_LIMITS.chunkMax + KB_LIMITS.chunkOverlap + 2);
    // Every paragraph is somewhere in the output.
    for (let i = 0; i < 12; i++) expect(chunks.some((c) => c.includes(`p${i}w0 `))).toBe(true);
  });

  it('overlaps consecutive chunks', () => {
    const text = Array.from({ length: 6 }, (_, i) => para(60, `q${i}w`)).join('\n\n');
    const [a, b] = chunkText(text);
    const lastWord = a.split(/\s+/).pop()!;
    expect(b).toContain(lastWord);
  });

  it('splits a huge paragraph on sentences, and a huge sentence on words', () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `Frase ${i} ${'x'.repeat(80)}.`).join(' ');
    const chunks = chunkText(sentences);
    expect(chunks.length).toBeGreaterThan(1);
    const wall = 'abc '.repeat(2000);
    for (const c of chunkText(wall)) expect(c.length).toBeLessThanOrEqual(KB_LIMITS.chunkMax + KB_LIMITS.chunkOverlap + 2);
  });

  it('FAQ is one "Pergunta/Resposta" chunk; long answers repeat the question', () => {
    expect(chunksForItem('faq', 'R$ 10.', 'Quanto custa?')).toEqual([faqChunk('Quanto custa?', 'R$ 10.')]);
    expect(faqChunk(' Q ', ' A ')).toBe('Pergunta: Q\nResposta: A');
    const long = chunksForItem('faq', Array.from({ length: 8 }, () => para(50)).join('\n\n'), 'Q?');
    expect(long.length).toBeGreaterThan(1);
    for (const c of long) {
      expect(c.startsWith('Pergunta: Q?\nResposta: ')).toBe(true);
      expect(c.length).toBeLessThan(4000);
    }
  });

  it('cleanText strips NULs and BOM', () => {
    expect(cleanText('﻿a\u0000b')).toBe('ab');
  });
});

describe('parseKbItemInput', () => {
  it('validates FAQ, text and file limits', () => {
    expect(parseKbItemInput('faq', { question: ' Entregam? ', content: 'Sim' })).toEqual({
      ok: true,
      value: { title: 'Entregam?', question: 'Entregam?', content: 'Sim' },
    });
    expect(parseKbItemInput('faq', { content: 'Sim' })).toEqual({ ok: false, error: KB_ERRORS.question });
    expect(parseKbItemInput('text', { title: '', content: 'x' })).toEqual({ ok: false, error: KB_ERRORS.title });
    expect(parseKbItemInput('text', { title: 't', content: ' ' })).toEqual({ ok: false, error: KB_ERRORS.content });
    expect(parseKbItemInput('text', { title: 't', content: 'x'.repeat(20_001) })).toEqual({ ok: false, error: KB_ERRORS.content });
    expect(parseKbItemInput('file', { title: 't', content: 'x'.repeat(20_001) }).ok).toBe(true);
    expect(parseKbItemInput('text', null)).toEqual({ ok: false, error: KB_ERRORS.body });
  });

  it('a FAQ with a question longer than a title still saves (title = question cut at 200)', () => {
    const question = `${'Q'.repeat(199)}😀 e mais texto?`;
    const r = parseKbItemInput('faq', { title: '', question, content: 'Sim' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.question).toBe(question);
    expect(r.value.title.length).toBeLessThanOrEqual(KB_LIMITS.titleMaxChars);
    expect(r.value.title).toBe('Q'.repeat(199)); // never half an emoji
    const long = parseKbItemInput('faq', { title: 'x'.repeat(500), question: 'Q?', content: 'Sim' });
    expect(long.ok && long.value.title.length).toBe(200);
  });
});

describe('sliceChars', () => {
  it('never splits a surrogate pair', () => {
    expect(sliceChars('ab😀cd', 0, 3)).toBe('ab');
    expect(sliceChars('ab😀cd', 3)).toBe('cd');
    expect(sliceChars('ab😀cd', -3)).toBe('cd');
    expect(sliceChars('ab😀cd', 0, 4)).toBe('ab😀');
    expect(cleanText('a\uD800b\uDC00c😀')).toBe('abc😀');
  });
});

describe('kbQueryFromMessages / selectKbHits', () => {
  it('uses the last customer message; prepends earlier ones (max 3) only when it is very short', () => {
    const msgs = [
      { sender_type: 'customer', content_text: 'oi, bom dia' },
      { sender_type: 'customer', content_text: 'quanto custa a entrega?' },
      { sender_type: 'agent', content_text: 'resposta do atendente' },
    ];
    expect(kbQueryFromMessages(msgs)).toBe('quanto custa a entrega?');
    const short = [
      { sender_type: 'customer', content_text: 'um' },
      { sender_type: 'customer', content_text: 'dois' },
      { sender_type: 'agent', content_text: 'resposta do atendente' },
      { sender_type: 'customer', content_text: null },
      { sender_type: 'customer', content_text: 'três' },
      { sender_type: 'customer', content_text: 'quatro' },
    ];
    expect(kbQueryFromMessages(short)).toBe('dois\ntrês\nquatro');
    expect(kbQueryFromMessages([...msgs, { sender_type: 'customer', content_text: 'e no centro?' }])).toBe(
      'quanto custa a entrega?\ne no centro?',
    );
    expect(kbQueryFromMessages([{ sender_type: 'agent', content_text: 'x' }])).toBe('');
  });

  it('caps chunk count and total chars', () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({ content: `${i}`.repeat(1500) }));
    const sel = selectKbHits(hits);
    expect(sel.length).toBeLessThanOrEqual(5);
    expect(sel.reduce((n, h) => n + h.content.length, 0)).toBeLessThanOrEqual(KB_LIMITS.promptMaxChars + 1);
  });
});

// ---- file extraction ------------------------------------------------

/** A minimal valid PDF (one page), optionally with a text line. */
function makePdf(text: string | null): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('extractFileText', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('reads .txt and .md as UTF-8', async () => {
    expect(await extractFileText('a.txt', enc('﻿Preço: R$ 10\r\n'))).toBe('Preço: R$ 10');
    expect(await extractFileText('A.MD', enc('# Título\n\ntexto'))).toBe('# Título\n\ntexto');
  });

  it('reads .csv, falling back to Windows-1252', async () => {
    expect(await extractFileText('p.csv', enc('produto;preço\npão;1,00'))).toBe('produto;preço\npão;1,00');
    const latin1 = Uint8Array.from([0x70, 0x72, 0x65, 0xe7, 0x6f]); // "preço" in cp1252
    expect(await extractFileText('p.csv', latin1)).toBe('preço');
  });

  it('extracts text from a PDF', async () => {
    const text = await extractFileText('tabela.pdf', makePdf('Tabela de precos: entrega R$ 10 no centro'));
    expect(text).toContain('Tabela de precos: entrega R$ 10 no centro');
  });

  it('rejects a PDF without text (scanned) with a clear message', async () => {
    await expect(extractFileText('scan.pdf', makePdf(null))).rejects.toThrow(KB_EXTRACT_ERRORS.pdfNoText);
  });

  it('rejects garbage PDFs, unknown types, empty and oversized files', async () => {
    await expect(extractFileText('x.pdf', enc('not a pdf'))).rejects.toThrow(KB_EXTRACT_ERRORS.pdfInvalid);
    await expect(extractFileText('x.docx', enc('x'))).rejects.toThrow(KB_EXTRACT_ERRORS.type);
    await expect(extractFileText('x.txt', enc('  \n '))).rejects.toThrow(KB_EXTRACT_ERRORS.empty);
    await expect(extractFileText('x.txt', new Uint8Array(KB_LIMITS.fileMaxBytes + 1))).rejects.toThrow(KB_EXTRACT_ERRORS.size);
    await expect(extractFileText('x.txt', enc('a'.repeat(200_001)))).rejects.toThrow(KB_EXTRACT_ERRORS.tooLong);
  });

  it('rejects "text" files that are really binary', async () => {
    await expect(extractFileText('x.txt', enc('abc\u0000def'))).rejects.toThrow(KB_EXTRACT_ERRORS.notText);
    const junk = Uint8Array.from({ length: 200 }, (_, i) => (i % 2 ? 0x01 : 0x41));
    await expect(extractFileText('x.csv', junk)).rejects.toThrow(KB_EXTRACT_ERRORS.notText);
  });
});

// ---- heavy PDFs (real worker) ---------------------------------------

/** A PDF of `pages` pages sharing one flate-compressed content stream of `reps` text lines. */
function makeHeavyPdf(pages: number, reps: number): Uint8Array {
  const objs: (string | Buffer)[] = [];
  const add = (o: string | Buffer) => objs.push(o);
  add(''); // 1 catalog
  add(''); // 2 pages
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 3
  const comp = deflateSync(Buffer.from('BT /F1 12 Tf 10 700 Td (Ola mundo preco entrega frete) Tj ET\n'.repeat(reps)));
  add(Buffer.concat([Buffer.from(`<< /Length ${comp.length} /Filter /FlateDecode >>\nstream\n`), comp, Buffer.from('\nendstream')])); // 4
  const kids: number[] = [];
  for (let p = 0; p < pages; p++) {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>`);
    kids.push(objs.length);
  }
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offs: number[] = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o), Buffer.from('\nendobj\n')]);
    offs.push(len);
    len += b.length;
    parts.push(b);
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

describe('PDF worker limits', () => {
  it('rejects too many pages before reading them', async () => {
    await expect(extractFileText('big.pdf', makeHeavyPdf(301, 1))).rejects.toThrow(KB_EXTRACT_ERRORS.pdfTooManyPages);
  });

  it('stops page by page once the text passes the limit, without blocking the event loop', async () => {
    let ticks = 0;
    const iv = setInterval(() => ticks++, 10);
    const started = Date.now();
    try {
      await expect(extractFileText('long.pdf', makeHeavyPdf(3, 3000))).rejects.toThrow(KB_EXTRACT_ERRORS.tooLong);
    } finally {
      clearInterval(iv);
    }
    const elapsed = Date.now() - started;
    if (elapsed > 200) expect(ticks).toBeGreaterThan(elapsed / 10 / 4);
  });

  it('kills a worker that runs out of its heap cap', async () => {
    await expect(pdfTextInWorker(makeHeavyPdf(1, 100_000), { heapMb: 16 })).rejects.toThrow(KB_EXTRACT_ERRORS.pdfTooHeavy);
  });

  it('kills a worker that passes the timeout', async () => {
    await expect(pdfTextInWorker(makeHeavyPdf(1, 100_000), { timeoutMs: 50 })).rejects.toThrow(KB_EXTRACT_ERRORS.pdfTimeout);
  });
});
