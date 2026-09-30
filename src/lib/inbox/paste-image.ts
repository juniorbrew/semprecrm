/**
 * Ctrl+V of an image in the reply box: decide what the clipboard holds and
 * whether it may become an attachment. Pure (duck-typed clipboard), so it is
 * tested with a fake ClipboardEvent. The composer stages the resulting file
 * exactly like one picked from the photo button.
 */

/** What WhatsApp accepts as an image (see lib/whatsapp/media-limits). */
export const PASTE_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const

export interface ClipboardLike {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null
  getData?: (format: string) => string
}

export interface PasteContext {
  /** Reply tab (false on the internal-note tab: nothing to attach there). */
  replyMode: boolean
  readOnly: boolean
  /** 24 h window closed: free-form media cannot be sent. */
  sessionExpired: boolean
  /** An upload is already running. */
  busy: boolean
  maxBytes: number
}

export type PasteOutcome =
  /** Not ours: let the browser paste text as usual. */
  | { kind: 'none' }
  /** Swallow the paste, no message (e.g. an upload is in progress). */
  | { kind: 'ignore' }
  | { kind: 'file'; file: File }
  | { kind: 'error'; reason: 'expired' | 'unsupported' | 'tooLarge'; sizeMb?: string; limitMb?: number }

/** A screenshot has a name like "image.png"; give it something recognisable. */
export function pastedFileName(type: string, now: number = Date.now()): string {
  return `pasted-${now}.${type === 'image/jpeg' ? 'jpg' : 'png'}`
}

export function resolvePastedImage(
  data: ClipboardLike | null | undefined,
  ctx: PasteContext,
  now: number = Date.now(),
): PasteOutcome {
  if (!ctx.replyMode || ctx.readOnly || !data?.items) return { kind: 'none' }
  const items = Array.from(data.items)
  const image = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'))
  if (!image) return { kind: 'none' }
  // Copying cells / rich text puts an image AND text on the clipboard: the
  // text is what the agent wants.
  if ((data.getData?.('text/plain') ?? '').trim()) return { kind: 'none' }

  const file = image.getAsFile()
  if (!file) return { kind: 'none' }
  if (ctx.sessionExpired) return { kind: 'error', reason: 'expired' }
  if (ctx.busy) return { kind: 'ignore' }
  const type = file.type || image.type
  if (!(PASTE_IMAGE_TYPES as readonly string[]).includes(type)) return { kind: 'error', reason: 'unsupported' }
  if (file.size > ctx.maxBytes) {
    return {
      kind: 'error',
      reason: 'tooLarge',
      sizeMb: (file.size / 1024 / 1024).toFixed(1),
      limitMb: Math.round(ctx.maxBytes / 1024 / 1024),
    }
  }
  return { kind: 'file', file: new File([file], pastedFileName(type, now), { type }) }
}
