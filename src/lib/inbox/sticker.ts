/**
 * Stickers arrive as `image` messages (messages.content_type has no
 * sticker value) with no caption. They are told apart by the media type:
 * WhatsApp photos are JPEG, stickers are WebP.
 */
export function isStickerMedia(input: {
  contentType: string
  caption?: string | null
  /** Media URL (QR channel files keep their `.webp` name). */
  url?: string | null
  /** Known MIME type (a fetched blob's `type` for the proxied Meta media). */
  mime?: string | null
}): boolean {
  if (input.contentType !== 'image' || input.caption) return false
  if (input.mime) return input.mime.toLowerCase() === 'image/webp'
  const path = (input.url ?? '').split(/[?#]/)[0]
  return /\.webp$/i.test(path)
}
