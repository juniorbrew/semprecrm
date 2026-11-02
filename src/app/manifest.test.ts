import { describe, expect, it } from 'vitest';

import manifest from './manifest';
import { GET, ICON_VARIANTS, generateStaticParams } from './icons/[variant]/route';

describe('installable app manifest', () => {
  const m = manifest();

  it('opens full screen on the logged-in home', () => {
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/dashboard');
    expect(m.scope).toBe('/');
  });

  it('lists the 192/512 icons Chrome needs to offer install, plus a maskable one, all served by /icons/[variant]', () => {
    const icons = m.icons ?? [];
    for (const icon of icons) {
      const variant = icon.src.replace('/icons/', '') as keyof typeof ICON_VARIANTS;
      expect(ICON_VARIANTS[variant], icon.src).toBeDefined();
      expect(icon.sizes).toBe(`${ICON_VARIANTS[variant].px}x${ICON_VARIANTS[variant].px}`);
    }
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(generateStaticParams().map((p) => p.variant).sort()).toEqual(Object.keys(ICON_VARIANTS).sort());
  });

  it('answers 404 for an unknown icon instead of drawing something', async () => {
    const res = await GET(new Request('http://x/icons/999'), { params: Promise.resolve({ variant: '999' }) });
    expect(res.status).toBe(404);
    const proto = await GET(new Request('http://x/icons/toString'), { params: Promise.resolve({ variant: 'toString' }) });
    expect(proto.status).toBe(404);
  });
});
