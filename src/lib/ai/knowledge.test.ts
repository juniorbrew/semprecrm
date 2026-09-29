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
} from './knowledge';
import { extractFileText, KB_EXTRACT_ERRORS } from './knowledge-extract';

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
});

describe('kbQueryFromMessages / selectKbHits', () => {
  it('uses the last 3 customer messages with text, oldest first', () => {
    const q = kbQueryFromMessages([
      { sender_type: 'customer', content_text: 'um' },
      { sender_type: 'customer', content_text: 'dois' },
      { sender_type: 'agent', content_text: 'resposta do atendente' },
      { sender_type: 'customer', content_text: null },
      { sender_type: 'customer', content_text: 'três' },
      { sender_type: 'customer', content_text: 'quatro' },
    ]);
    expect(q).toBe('dois\ntrês\nquatro');
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
});
