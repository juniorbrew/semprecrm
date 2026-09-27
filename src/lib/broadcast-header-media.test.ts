import { describe, expect, it } from 'vitest';
import {
  headerMediaMessageParams,
  headerMediaUrlError,
  mediaHeaderTypeOf,
} from './broadcast-header-media';

describe('mediaHeaderTypeOf', () => {
  it('recognises image / video / document headers', () => {
    expect(mediaHeaderTypeOf({ header_type: 'image' })).toBe('image');
    expect(mediaHeaderTypeOf({ header_type: 'video' })).toBe('video');
    expect(mediaHeaderTypeOf({ header_type: 'document' })).toBe('document');
  });

  it('is null for text or missing headers', () => {
    expect(mediaHeaderTypeOf({ header_type: 'text' })).toBeNull();
    expect(mediaHeaderTypeOf({})).toBeNull();
  });
});

describe('headerMediaUrlError', () => {
  it('never blocks a template without a media header', () => {
    expect(headerMediaUrlError(null, '')).toBeNull();
  });

  it('requires a URL for media headers', () => {
    expect(headerMediaUrlError('image', '')).toBe('missing');
    expect(headerMediaUrlError('video', '   ')).toBe('missing');
  });

  it('accepts absolute http(s) URLs', () => {
    expect(headerMediaUrlError('image', 'https://cdn.example.com/a.jpg')).toBeNull();
    expect(headerMediaUrlError('document', 'http://example.com/a.pdf')).toBeNull();
  });

  it('accepts an origin-relative stored media URL (our own storage)', () => {
    expect(
      headerMediaUrlError('image', '/supabase/storage/v1/object/public/chat-media/x.jpg'),
    ).toBeNull();
  });

  it('rejects non-http schemes, protocol-relative and garbage', () => {
    expect(headerMediaUrlError('image', 'ftp://example.com/a.jpg')).toBe('invalid');
    expect(headerMediaUrlError('image', '//evil.example/a.jpg')).toBe('invalid');
    expect(headerMediaUrlError('image', 'not a url')).toBe('invalid');
  });
});

describe('headerMediaMessageParams', () => {
  it('passes the trimmed URL for media-header templates', () => {
    expect(
      headerMediaMessageParams({ header_type: 'image' }, '  https://x.test/a.jpg '),
    ).toEqual({ headerMediaUrl: 'https://x.test/a.jpg' });
  });

  it('omits params for text headers or an empty URL', () => {
    expect(headerMediaMessageParams({ header_type: 'text' }, 'https://x.test/a.jpg')).toBeUndefined();
    expect(headerMediaMessageParams({ header_type: 'video' }, '')).toBeUndefined();
    expect(headerMediaMessageParams({ header_type: 'video' }, undefined)).toBeUndefined();
  });
});
