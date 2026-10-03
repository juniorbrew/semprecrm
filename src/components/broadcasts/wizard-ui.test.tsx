import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { WizardStepper, optionRowClass, pillClass } from './wizard-ui';

const steps = [
  { key: 'template', label: 'Modelo' },
  { key: 'audience', label: 'Público' },
  { key: 'send', label: 'Enviar' },
];

describe('WizardStepper', () => {
  it('marks the current step with aria-current and the brand accent, finished ones with a check', () => {
    const html = renderToString(<WizardStepper steps={steps} current={1} label="Etapas" />);
    expect(html).toContain('aria-label="Etapas"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*border-primary/);
    expect(html).toContain('lucide-check');
    expect(html).toContain('>3<');
  });
});

describe('option and pill classes', () => {
  it('tints the selected option with the 3 px accent', () => {
    expect(optionRowClass(true)).toContain('bg-primary/10');
    expect(optionRowClass(true)).toContain('inset_3px_0_0_var(--primary)');
    expect(optionRowClass(false)).not.toContain('bg-primary/10');
  });

  it('uses the brand pill when on and red only for the exclude list', () => {
    expect(pillClass(true)).toContain('bg-primary/15');
    expect(pillClass(true, 'danger')).toContain('bg-red-500/15');
    expect(pillClass(false, 'danger')).toContain('bg-muted');
  });
});
