import { describe, expect, it } from 'vitest';

import { resolveSection, SECTION_META } from './settings-sections';

describe('Settings -> Produtos e serviços', () => {
  it('is gated by the pipelines module (the rail hides it when the plan lacks it) and open to every member to read', () => {
    expect(SECTION_META.products.module).toBe('pipelines');
    expect(SECTION_META.products.adminOnly).toBeUndefined();
  });
  it('opens from ?tab=products', () => {
    expect(resolveSection('products')).toBe('products');
  });
});
