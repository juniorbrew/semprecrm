import { appManifest } from '@/lib/pwa/app-manifest';

export const dynamic = 'force-static';

export function GET() {
  return new Response(JSON.stringify(appManifest()), {
    headers: { 'Content-Type': 'application/manifest+json' },
  });
}
