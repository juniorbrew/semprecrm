// Installed-app icons listed in app/manifest.ts. `maskable` fills the
// whole square and keeps the glyph inside the central safe zone, so
// Android can crop it to any shape.
export const ICON_VARIANTS = {
  '192': { px: 192, radius: 36, glyph: 116 },
  '512': { px: 512, radius: 96, glyph: 308 },
  maskable: { px: 512, radius: 0, glyph: 240 },
} as const;
