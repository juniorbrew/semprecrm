// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ pipelines: true, ready: true }));

vi.mock('@/hooks/use-language', () => ({ useLanguage: () => ({ t: (s: string) => s, language: 'pt-BR' }) }));
vi.mock('@/hooks/use-auth', () => ({
  useEntitlements: () => ({ ready: h.ready, modules: { pipelines: h.pipelines } }),
}));
vi.mock('@/components/contacts/custom-fields-manager', () => ({ CustomFieldsPanel: () => <div>contact panel</div> }));
vi.mock('./deal-fields-settings', () => ({ DealFieldsSettings: () => <div>deal panel</div> }));

import { CustomFieldsSettings } from './custom-fields-settings';

afterEach(cleanup);

describe('CustomFieldsSettings', () => {
  it('with the pipelines module: Contact tab first (today screen), Deal tab on click', () => {
    h.pipelines = true;
    h.ready = true;
    render(<CustomFieldsSettings />);
    expect(screen.getByText('contact panel')).toBeTruthy();
    expect(screen.queryByText('deal panel')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Deal fields' }));
    expect(screen.getByText('deal panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Contact fields' }));
    expect(screen.getByText('contact panel')).toBeTruthy();
  });

  it('without the module, or until entitlements load, only the contact fields exist', () => {
    h.pipelines = false;
    h.ready = true;
    const a = render(<CustomFieldsSettings />);
    expect(screen.getByText('contact panel')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    a.unmount();
    h.pipelines = true;
    h.ready = false;
    render(<CustomFieldsSettings />);
    expect(screen.getByText('contact panel')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});
