// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';

import type { Message } from '@/types';
import { LanguageProvider } from './use-language';
import { MessageBubble } from '@/components/inbox/message-bubble';

const flush = () => new Promise((r) => setTimeout(r, 0));

function customer(content_text: string, content_type = 'text'): Message {
  return {
    id: `m-${content_text}`,
    conversation_id: 'c-1',
    sender_type: 'customer',
    content_type,
    content_text,
    status: 'read',
    created_at: '2026-10-01T12:00:00.000Z',
  } as Message;
}

describe('DOM translator', () => {
  it('translates UI copy but never what the customer wrote', async () => {
    const view = render(
      <LanguageProvider>
        <span data-testid="ui">You</span>
        <MessageBubble message={customer('You')} />
      </LanguageProvider>,
    );
    await act(flush);
    expect(view.getByTestId('ui').textContent).toBe('Você');
    expect(view.container.querySelector('p')?.textContent).toBe('You');

    // Messages arriving later go through the MutationObserver path.
    view.rerender(
      <LanguageProvider>
        <span data-testid="ui">You</span>
        <MessageBubble message={customer('You')} />
        <MessageBubble message={customer('Survey', 'interactive')} />
      </LanguageProvider>,
    );
    await act(flush);
    const texts = [...view.container.querySelectorAll('p')].map((p) => p.textContent);
    expect(texts).toEqual(['You', 'Survey']);
  });

  it('skips a no-translate subtree as a whole, including late children', async () => {
    const view = render(
      <LanguageProvider>
        <div data-no-translate>
          <span>
            <b>You</b>
          </span>
        </div>
        <div>
          <span>
            <b>You</b>
          </span>
        </div>
      </LanguageProvider>,
    );
    await act(flush);
    const [kept, translated] = [...view.container.querySelectorAll('b')];
    expect(kept.textContent).toBe('You');
    expect(translated.textContent).toBe('Você');

    const late = document.createElement('i');
    late.textContent = 'You';
    kept.parentElement!.appendChild(late);
    await act(flush);
    expect(late.textContent).toBe('You');
  });
});
