import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getMediaUrl, downloadMedia, isMetaMediaId } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  let ctx
  try {
    // Any account member may view media (viewers read the inbox too);
    // the account comes from the session, never from the request.
    ctx = await requireRole('viewer')
  } catch (err) {
    return toErrorResponse(err)
  }

  const limit = checkRateLimit(`wa-media:${ctx.userId}`, RATE_LIMITS.mediaProxy)
  if (!limit.success) return rateLimitResponse(limit)

  const { mediaId } = await params
  // Meta media ids are numeric; anything else must never be spliced
  // into the Graph API path.
  if (!isMetaMediaId(mediaId)) {
    return NextResponse.json({ error: 'Invalid media id' }, { status: 400 })
  }

  try {
    const { data: config, error: configError } = await ctx.supabase
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', ctx.accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        // Customer media: browser cache only, never a shared proxy/CDN.
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
