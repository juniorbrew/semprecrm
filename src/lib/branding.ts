// ============================================================
// White-label branding (spec round 2 §6, migration 037) — pure.
//
// `accounts.branding` is a jsonb `{ app_name, logo_url, primary_color }`
// where every key is optional. `parseBranding` fills the SempreCRM
// defaults so the shell can read it unconditionally; `isBrandingActive`
// tells whether anything differs from the defaults (used to decide
// whether to override the theme's --primary).
//
// The module gate (`white_label` in the plan) is applied by the
// callers — this file only normalises the data.
// ============================================================

export interface Branding {
  /** Shown in the sidebar, header and document title. */
  app_name: string;
  /** Public URL of the logo (account-branding bucket), or null = default mark. */
  logo_url: string | null;
  /** `#rrggbb`, or null = keep the theme's accent. */
  primary_color: string | null;
}

export const DEFAULT_APP_NAME = 'SempreCRM';

export const DEFAULT_BRANDING: Branding = {
  app_name: DEFAULT_APP_NAME,
  logo_url: null,
  primary_color: null,
};

export const BRANDING_LIMITS = {
  app_name: { max: 40 },
  logo: { maxBytes: 512 * 1024, mimeTypes: ['image/png', 'image/svg+xml', 'image/webp'] },
} as const;

/** Curated palette offered in Settings → Marca next to the free hex field. */
export const BRANDING_PALETTE: readonly { hex: string; name: string }[] = [
  { hex: '#7c3aed', name: 'Violet' },
  { hex: '#2563eb', name: 'Blue' },
  { hex: '#0891b2', name: 'Cyan' },
  { hex: '#059669', name: 'Green' },
  { hex: '#65a30d', name: 'Lime' },
  { hex: '#d97706', name: 'Amber' },
  { hex: '#ea580c', name: 'Orange' },
  { hex: '#dc2626', name: 'Red' },
  { hex: '#db2777', name: 'Pink' },
  { hex: '#475569', name: 'Slate' },
];

const HEX_RE = /^#([0-9a-f]{6})$/i;

/** `#rgb` / `#rrggbb` (case-insensitive) → lowercase `#rrggbb`; else null. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return ('#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase();
  }
  return HEX_RE.test(v) ? v.toLowerCase() : null;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Normalise the raw jsonb into a `Branding` with defaults. Never throws. */
export function parseBranding(raw: unknown): Branding {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_BRANDING };
  const r = raw as Record<string, unknown>;
  const name =
    typeof r.app_name === 'string' ? r.app_name.trim().slice(0, BRANDING_LIMITS.app_name.max) : '';
  return {
    app_name: name || DEFAULT_APP_NAME,
    logo_url: isHttpUrl(r.logo_url) ? r.logo_url : null,
    primary_color: normalizeHexColor(r.primary_color),
  };
}

/** True when the account customised anything (name, logo or colour). */
export function isBrandingActive(b: Branding): boolean {
  return b.app_name !== DEFAULT_APP_NAME || b.logo_url !== null || b.primary_color !== null;
}

export interface BrandingPatch {
  app_name?: string | null;
  logo_url?: string | null;
  primary_color?: string | null;
}

export type BrandingValidation =
  | { ok: true; branding: Record<string, string> }
  | { ok: false; error: string };

/**
 * Validate a client patch and produce the jsonb to store. `null` /
 * empty string clears a key (back to default); absent keys keep the
 * `existing` value. Only stored keys are the customised ones, so a
 * fully-reset account goes back to `{}`.
 */
export function validateBrandingPatch(
  existing: unknown,
  patch: unknown,
): BrandingValidation {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const p = patch as Record<string, unknown>;
  const base = parseBranding(existing);
  const out: Record<string, string> = {};

  // app_name ---------------------------------------------------
  let appName: string | null = base.app_name === DEFAULT_APP_NAME ? null : base.app_name;
  if ('app_name' in p) {
    if (p.app_name === null || p.app_name === '') appName = null;
    else if (typeof p.app_name !== 'string') return { ok: false, error: 'app_name must be a string' };
    else {
      const v = p.app_name.trim();
      if (v.length > BRANDING_LIMITS.app_name.max) {
        return { ok: false, error: `app_name must be ${BRANDING_LIMITS.app_name.max} characters or fewer` };
      }
      appName = v || null;
    }
  }
  if (appName && appName !== DEFAULT_APP_NAME) out.app_name = appName;

  // logo_url ---------------------------------------------------
  let logo: string | null = base.logo_url;
  if ('logo_url' in p) {
    if (p.logo_url === null || p.logo_url === '') logo = null;
    else if (!isHttpUrl(p.logo_url)) return { ok: false, error: 'logo_url must be an http(s) URL' };
    else logo = p.logo_url;
  }
  if (logo) out.logo_url = logo;

  // primary_color ----------------------------------------------
  let color: string | null = base.primary_color;
  if ('primary_color' in p) {
    if (p.primary_color === null || p.primary_color === '') color = null;
    else {
      const n = normalizeHexColor(p.primary_color);
      if (!n) return { ok: false, error: 'primary_color must be a #rrggbb hex colour' };
      color = n;
    }
  }
  if (color) out.primary_color = color;

  return { ok: true, branding: out };
}

// ------------------------------------------------------------
// Colour helpers for the shell — hex → CSS variables.
// ------------------------------------------------------------

/** Relative luminance (sRGB) of a `#rrggbb` colour, 0..1. */
export function hexLuminance(hex: string): number {
  const n = normalizeHexColor(hex);
  if (!n) return 0;
  const chan = (i: number) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(1) + 0.7152 * chan(3) + 0.0722 * chan(5);
}

/** Readable foreground for a solid `primary_color` button. */
export function primaryForeground(hex: string): string {
  return hexLuminance(hex) > 0.45 ? '#0f172a' : '#ffffff';
}

/**
 * Inline style overriding the theme's primary tokens. Applied on the
 * dashboard shell root when the `white_label` module is on and the
 * account picked a colour; the user's light/dark mode and the rest of
 * the accent theme stay untouched.
 */
export function brandingCssVars(primary: string | null): Record<string, string> {
  const hex = primary ? normalizeHexColor(primary) : null;
  if (!hex) return {};
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const rgb = `${r} ${g} ${b}`;
  return {
    '--primary': hex,
    '--primary-foreground': primaryForeground(hex),
    '--primary-hover': `rgb(${rgb} / 0.88)`,
    '--primary-soft': `rgb(${rgb} / 0.12)`,
    '--primary-soft-2': `rgb(${rgb} / 0.2)`,
    '--ring': hex,
    '--sidebar-primary': hex,
    '--sidebar-primary-foreground': primaryForeground(hex),
  };
}
