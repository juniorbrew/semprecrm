import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APP_NAME,
  DEFAULT_BRANDING,
  brandingCssVars,
  isBrandingActive,
  normalizeHexColor,
  parseBranding,
  primaryForeground,
  validateBrandingPatch,
} from './branding';

describe('parseBranding', () => {
  it('fills defaults for anything that is not a well-formed object', () => {
    expect(parseBranding(null)).toEqual(DEFAULT_BRANDING);
    expect(parseBranding({})).toEqual(DEFAULT_BRANDING);
    expect(parseBranding('x')).toEqual(DEFAULT_BRANDING);
    expect(parseBranding({ app_name: '   ', logo_url: 'ftp://x', primary_color: 'red' })).toEqual(
      DEFAULT_BRANDING,
    );
  });

  it('keeps valid values and normalises the colour', () => {
    expect(
      parseBranding({ app_name: ' Acme CRM ', logo_url: 'https://cdn/logo.png', primary_color: '#ABC' }),
    ).toEqual({ app_name: 'Acme CRM', logo_url: 'https://cdn/logo.png', primary_color: '#aabbcc' });
  });

  it('isBrandingActive is false only for the pristine defaults', () => {
    expect(isBrandingActive(parseBranding({}))).toBe(false);
    expect(isBrandingActive(parseBranding({ app_name: DEFAULT_APP_NAME }))).toBe(false);
    expect(isBrandingActive(parseBranding({ primary_color: '#2563eb' }))).toBe(true);
  });
});

describe('normalizeHexColor', () => {
  it('accepts #rgb and #rrggbb only', () => {
    expect(normalizeHexColor('#7C3AED')).toBe('#7c3aed');
    expect(normalizeHexColor(' #fff ')).toBe('#ffffff');
    expect(normalizeHexColor('7c3aed')).toBeNull();
    expect(normalizeHexColor('#7c3ae')).toBeNull();
    expect(normalizeHexColor('rgb(1,2,3)')).toBeNull();
    expect(normalizeHexColor(12)).toBeNull();
  });
});

describe('validateBrandingPatch', () => {
  it('rejects non-objects and bad values', () => {
    expect(validateBrandingPatch({}, null)).toEqual({ ok: false, error: expect.any(String) });
    expect(validateBrandingPatch({}, { app_name: 5 }).ok).toBe(false);
    expect(validateBrandingPatch({}, { app_name: 'x'.repeat(41) }).ok).toBe(false);
    expect(validateBrandingPatch({}, { primary_color: 'blue' }).ok).toBe(false);
    expect(validateBrandingPatch({}, { logo_url: 'javascript:alert(1)' }).ok).toBe(false);
    expect(validateBrandingPatch({}, { logo_url: '//evil/x.png' }).ok).toBe(false);
  });

  it('accepts an origin-relative logo path (same-origin Supabase proxy)', () => {
    const rel = '/supabase/storage/v1/object/public/branding/account-1/logo.png';
    expect(validateBrandingPatch({}, { logo_url: rel })).toEqual({
      ok: true,
      branding: { logo_url: rel },
    });
    expect(parseBranding({ logo_url: rel }).logo_url).toBe(rel);
  });

  it('merges over the existing jsonb, storing only customised keys', () => {
    const existing = { app_name: 'Acme', primary_color: '#2563eb' };
    expect(validateBrandingPatch(existing, { logo_url: 'https://cdn/l.png' })).toEqual({
      ok: true,
      branding: { app_name: 'Acme', primary_color: '#2563eb', logo_url: 'https://cdn/l.png' },
    });
    // null / "" clear a key; the default app name is not stored.
    expect(
      validateBrandingPatch(existing, { app_name: DEFAULT_APP_NAME, primary_color: '' }),
    ).toEqual({ ok: true, branding: {} });
    expect(validateBrandingPatch(existing, { app_name: null, primary_color: null })).toEqual({
      ok: true,
      branding: {},
    });
  });
});

describe('colour helpers', () => {
  it('picks a readable foreground', () => {
    expect(primaryForeground('#7c3aed')).toBe('#ffffff');
    expect(primaryForeground('#ffffff')).toBe('#0f172a');
    expect(primaryForeground('#fde047')).toBe('#0f172a');
  });

  it('brandingCssVars overrides --primary and --ring, or nothing', () => {
    expect(brandingCssVars(null)).toEqual({});
    expect(brandingCssVars('nope')).toEqual({});
    const vars = brandingCssVars('#2563eb');
    expect(vars['--primary']).toBe('#2563eb');
    expect(vars['--ring']).toBe('#2563eb');
    expect(vars['--primary-foreground']).toBe('#ffffff');
    expect(vars['--primary-soft']).toBe('rgb(37 99 235 / 0.12)');
  });
});
