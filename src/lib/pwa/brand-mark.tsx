// The brand mark (violet square + white chat-square glyph), drawn for
// next/og ImageResponse. Shared by the favicon (app/icon.tsx), the iOS
// home-screen icon (app/apple-icon.tsx) and the installed-app icons
// (app/icons/[variant]) so they never drift apart. Matches the sidebar
// logo in `src/components/layout/sidebar.tsx`.

export const BRAND_PURPLE = '#7c3aed';

export function BrandMark({ radius, glyph }: { radius: number; glyph: number }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: BRAND_PURPLE,
        borderRadius: radius,
      }}
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>
  );
}
