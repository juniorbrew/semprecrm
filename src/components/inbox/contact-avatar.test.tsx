import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import { ContactAvatar, avatarInitial } from './contact-avatar';

describe('ContactAvatar', () => {
  it('renders the stored photo when there is one', () => {
    const html = renderToString(
      <ContactAvatar src="/supabase/storage/v1/object/public/contact-avatars/account-a/c?v=1" name="Maria" />,
    );
    expect(html).toContain('<img');
    expect(html).toContain('alt="Maria"');
    expect(html).not.toContain('>M<');
  });

  it('falls back to the initial without a photo', () => {
    const html = renderToString(<ContactAvatar src={null} name="maria" />);
    expect(html).not.toContain('<img');
    expect(html).toContain('>M<');
  });

  it('initial helper handles blanks', () => {
    expect(avatarInitial('  ana ')).toBe('A');
    expect(avatarInitial('')).toBe('?');
    expect(avatarInitial(undefined)).toBe('?');
  });
});
