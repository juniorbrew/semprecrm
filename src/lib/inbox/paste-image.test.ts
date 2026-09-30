import { describe, expect, it } from 'vitest'
import { resolvePastedImage, type ClipboardLike, type PasteContext } from './paste-image'

const ctx: PasteContext = { replyMode: true, readOnly: false, sessionExpired: false, busy: false, maxBytes: 5 * 1024 * 1024 }

/** Mock of ClipboardEvent.clipboardData. */
function clipboard(files: File[], text = ''): ClipboardLike {
  return {
    items: [
      ...files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
      ...(text ? [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] : []),
    ],
    getData: (format) => (format === 'text/plain' ? text : ''),
  }
}
const png = (size = 10) => new File([new Uint8Array(size)], 'image.png', { type: 'image/png' })

describe('resolvePastedImage', () => {
  it('turns a pasted screenshot into a named file', () => {
    const out = resolvePastedImage(clipboard([png()]), ctx, 1700000000000)
    expect(out.kind).toBe('file')
    if (out.kind === 'file') {
      expect(out.file.name).toBe('pasted-1700000000000.png')
      expect(out.file.type).toBe('image/png')
      expect(out.file.size).toBe(10)
    }
  })

  it('leaves plain text (and text + image, e.g. copied cells) to the browser', () => {
    expect(resolvePastedImage(clipboard([], 'olá'), ctx)).toEqual({ kind: 'none' })
    expect(resolvePastedImage(clipboard([png()], 'A1\tB1'), ctx)).toEqual({ kind: 'none' })
    expect(resolvePastedImage(null, ctx)).toEqual({ kind: 'none' })
    expect(resolvePastedImage({ items: [] }, ctx)).toEqual({ kind: 'none' })
  })

  it('only in reply mode and never for read-only roles', () => {
    expect(resolvePastedImage(clipboard([png()]), { ...ctx, replyMode: false })).toEqual({ kind: 'none' })
    expect(resolvePastedImage(clipboard([png()]), { ...ctx, readOnly: true })).toEqual({ kind: 'none' })
  })

  it('respects the 24 h window', () => {
    expect(resolvePastedImage(clipboard([png()]), { ...ctx, sessionExpired: true })).toEqual({
      kind: 'error',
      reason: 'expired',
    })
  })

  it('enforces the size limit with the numbers for the toast', () => {
    const out = resolvePastedImage(clipboard([png(6 * 1024 * 1024)]), ctx)
    expect(out).toEqual({ kind: 'error', reason: 'tooLarge', sizeMb: '6.0', limitMb: 5 })
  })

  it('rejects formats WhatsApp does not take, ignores while uploading', () => {
    const webp = new File([new Uint8Array(4)], 'x.webp', { type: 'image/webp' })
    expect(resolvePastedImage(clipboard([webp]), ctx)).toEqual({ kind: 'error', reason: 'unsupported' })
    expect(resolvePastedImage(clipboard([png()]), { ...ctx, busy: true })).toEqual({ kind: 'ignore' })
  })
})
