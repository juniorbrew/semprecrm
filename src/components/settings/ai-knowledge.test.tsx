// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { AiKnowledge } from './ai-knowledge';
import type { KbItem, KbItemSummary } from '@/lib/ai/knowledge';

vi.mock('@/hooks/use-language', () => ({ useLanguage: () => ({ t: (key: string) => key, language: 'en' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const initial: KbItem & KbItemSummary = {
  id: 'kb-1', kind: 'faq', title: 'Delivery', question: 'Where do you deliver?',
  content: 'Saved answer', content_chars: 12, category: 'Policies', source_filename: null,
  enabled: true, latest_version: 2, published_version: 1,
  created_at: '2026-10-10T12:00:00Z', updated_at: '2026-10-10T12:00:00Z',
};
let item = { ...initial };
let publishStatus = 200;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  item = { ...initial };
  publishStatus = 200;
  request = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') {
      const body = JSON.parse(options.body as string);
      if ('publish_version' in body) {
        if (publishStatus !== 200) {
          if (publishStatus === 409) item.latest_version = 3;
          return { ok: false, status: publishStatus, json: async () => ({ error: 'Server error' }) };
        }
        item.published_version = body.publish_version;
      } else item = { ...item, ...body };
      return { ok: true, json: async () => ({ item: { ...item } }) };
    }
    if (url.endsWith('/restore')) {
      item.latest_version = 3;
      return { ok: true, json: async () => ({ item }) };
    }
    if (url.endsWith('/versions')) return { ok: true, json: async () => ({ versions: [
      { ...item, version_no: item.latest_version, restored_from: null, content: 'Full saved answer\nLast line of the reviewed version' },
      { ...item, version_no: 1, restored_from: null, content: 'Previously published answer' },
    ] }) };
    return { ok: true, json: async () => url === '/api/ai/knowledge' ? { items: [{ ...item }] } : { item } };
  });
  vi.stubGlobal('fetch', request);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openHistory() {
  render(<AiKnowledge />);
  fireEvent.click(await screen.findByRole('button', { name: 'Version history: Delivery' }));
  await screen.findByRole('button', { name: 'Review version 2' });
}

it('requires reviewing the latest saved version before publishing and updates status from the response', async () => {
  await openHistory();
  expect(screen.getByText(/Pending changes/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Publish version 2' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review version 1' }));
  expect(screen.queryByRole('button', { name: /Publish version/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review version 2' }));
  const preview = screen.getByRole('region', { name: 'Version preview' });
  expect(within(preview).getByText(/Last line of the reviewed version/)).toBeTruthy();
  expect(within(preview).getByText('Where do you deliver?')).toBeTruthy();
  fireEvent.click(within(preview).getByRole('button', { name: 'Publish version 2' }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Version published'));
  expect(request).toHaveBeenCalledWith('/api/ai/knowledge/kb-1', expect.objectContaining({ method: 'PATCH', body: '{"publish_version":2}' }));
  expect(screen.queryByText(/Pending changes/)).toBeNull();
  expect(screen.queryByRole('button', { name: /Publish version/ })).toBeNull();
});

it.each([409, 404])('handles publication failure %s without claiming success', async (status) => {
  publishStatus = status;
  await openHistory();
  fireEvent.click(screen.getByRole('button', { name: 'Review version 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Publish version 2' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(status === 409
    ? 'A newer draft exists. Review the latest version before publishing.'
    : 'Knowledge item not found. Refresh the knowledge base.'));
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Publish version 2' })).toBeNull();
});

it('restores an old version as a draft without publishing it', async () => {
  await openHistory();
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  await screen.findByRole('button', { name: 'Review version 3' });
  expect(item.published_version).toBe(1);
  expect(screen.queryByRole('button', { name: /Publish version/ })).toBeNull();
  expect(request.mock.calls.some(([, options]) => options?.body?.toString().includes('publish_version'))).toBe(false);
});

it.each([null, 2])('shows draft/published status and never publishes by toggling availability (%s)', async (published) => {
  item.published_version = published;
  render(<AiKnowledge />);
  await screen.findByText(published === null ? /^· Draft$/ : /· Published/);
  const toggle = screen.getByRole('switch', { name: 'Use published version in suggestions: Delivery' });
  if (published === null) {
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(toggle);
    expect(request.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  }
  else {
    fireEvent.click(toggle);
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/ai/knowledge/kb-1', expect.objectContaining({ body: '{"enabled":false}' })));
  }
});
