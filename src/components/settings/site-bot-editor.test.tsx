// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { LeadSource } from '@/types';

const h = vi.hoisted(() => ({
  qr: { phone_number: '+55 11 98888-7777', status: 'connected' } as { phone_number: string; status: string } | null,
  previews: [] as unknown[],
}));

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acct-1' }) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: h.qr }) }),
      }),
    }),
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The real preview loads /robo.js; it has its own test.
vi.mock('./site-bot-preview', () => ({
  SiteBotPreview: ({ config }: { config: unknown }) => {
    h.previews.push(config);
    return <div data-testid="preview" />;
  },
}));

import { BOT_ISSUE_KEYS, SiteBotEditor, describeIssue, type BotResources } from './site-bot-editor';

const FIELD = '11111111-1111-4111-8111-111111111111';
const resources: BotResources = {
  pipelines: [{ id: 'p1', name: 'Vendas' } as never, { id: 'p2', name: 'Pós-venda' } as never],
  stages: [
    { id: 's1', pipeline_id: 'p1', name: 'Novo' } as never,
    { id: 's2', pipeline_id: 'p1', name: 'Contato' } as never,
    { id: 's3', pipeline_id: 'p2', name: 'Aberto' } as never,
  ],
  tags: [{ id: 't1', name: 'Site', color: '#2563eb' } as never],
  members: [{ user_id: 'u1', full_name: 'Ana', email: 'ana@x.com' } as never],
  customFields: [{ id: FIELD, field_name: 'Interesse' } as never],
};

let fetchMock: ReturnType<typeof vi.fn>;
let saveResponse: () => Response;

beforeEach(() => {
  h.qr = { phone_number: '+55 11 98888-7777', status: 'connected' };
  h.previews.length = 0;
  saveResponse = () =>
    new Response(JSON.stringify({ source: { id: 'new-1', name: 'Robo', kind: 'site_bot', public_key: 'a'.repeat(32) } }), { status: 201 });
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/whatsapp/config') return new Response(JSON.stringify({ connected: false }), { status: 200 });
    return saveResponse();
  });
  window.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const saves = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/site-bots'));
const bodyOfSave = () => JSON.parse(saves()[0][1].body as string);

function baseBot(): LeadSource {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Robo antigo',
    is_active: false,
    kind: 'site_bot',
    public_key: 'a'.repeat(32),
    pipeline_id: 'p1',
    stage_id: 's1',
    tag_ids: [],
    assignee_user_id: null,
    bot_config: {
      appearance: { botName: 'Ju', color: '#ff0000', bubbleText: 'Oi!', side: 'left' },
      greeting: 'Salve',
      questions: [
        { id: 'nome', text: 'Seu nome?', type: 'name', required: true },
        { id: 'fone', text: 'Seu zap?', type: 'phone', required: true },
      ],
      end: { thanks: 'Valeu', whatsappEnabled: false, whatsappNumber: '', messageTemplate: '' },
      lgpd: { text: 'Aceito', linkUrl: '' },
      domains: ['loja.com.br'],
    },
  } as unknown as LeadSource;
}

function open(source: LeadSource | null = null, res: BotResources = resources) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<SiteBotEditor source={source} resources={res} onClose={onClose} onSaved={onSaved} />);
  return { onSaved, onClose };
}

const setName = (v = 'Robo da Loja') => fireEvent.change(screen.getByLabelText('Nome do robô nesta lista'), { target: { value: v } });
const create = () => fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
/** The new-bot defaults (pipeline, stage, WhatsApp number) arrive from effects. */
const settled = () => waitFor(() => expect(screen.getByRole('option', { name: '+5511988887777' })).toBeTruthy());

describe('SiteBotEditor', () => {
  it('creates a bot: sends the draft to the server and reports the saved row', async () => {
    const { onSaved, onClose } = open();
    expect(screen.getByTestId('preview')).toBeTruthy();
    await settled();
    setName();
    fireEvent.change(screen.getByLabelText('Lado da tela'), { target: { value: 'left' } });
    fireEvent.change(screen.getByLabelText('Sites onde o robô pode funcionar'), {
      target: { value: 'https://www.MinhaLoja.com.br/contato\nloja.com.br' },
    });
    create();
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0][0]).toBe('/api/site-bots');
    expect(saves()[0][1].method).toBe('POST');
    const body = bodyOfSave();
    expect(body.name).toBe('Robo da Loja');
    expect(body.config.appearance.side).toBe('left');
    expect(body.config.domains).toEqual(['minhaloja.com.br', 'loja.com.br']);
    expect(body.config.questions.map((q: { type: string }) => q.type)).toEqual(['name', 'phone']);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-1' })));
    expect(onClose).toHaveBeenCalled();
  });

  it('starts a new bot on the first pipeline and its first stage, with no "no deal" option', async () => {
    open();
    await settled();
    setName();
    const selects = screen.getAllByRole('combobox');
    expect(selects.some((s) => within(s).queryByText('Não criar negócio'))).toBe(false);
    create();
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(bodyOfSave()).toMatchObject({ pipeline_id: 'p1', stage_id: 's1' });
  });

  it('moves to the first stage of another pipeline when the pipeline changes', async () => {
    open();
    await settled();
    setName();
    const pipeline = screen.getAllByRole('combobox').find((s) => within(s).queryByText('Vendas'))!;
    fireEvent.change(pipeline, { target: { value: 'p2' } });
    create();
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(bodyOfSave()).toMatchObject({ pipeline_id: 'p2', stage_id: 's3' });
  });

  it('refuses to save without a pipeline and stage (an existing bot that has none)', async () => {
    open({ ...baseBot(), pipeline_id: null, stage_id: null });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Escolha o funil onde os novos negócios entram.')).toBeTruthy();
    expect(saves()).toHaveLength(0);
  });

  it('turns the WhatsApp button on with the connected number for a new bot', async () => {
    open();
    await settled();
    setName();
    expect(screen.getByLabelText('Mostrar o botão Continuar no WhatsApp').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Número de WhatsApp da empresa') as HTMLSelectElement).value).toBe('5511988887777');
    create();
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(bodyOfSave().config.end).toMatchObject({ whatsappEnabled: true, whatsappNumber: '5511988887777' });
  });

  it('keeps "Another number", and a missing number is an error when the button is on', async () => {
    open();
    await settled();
    setName();
    fireEvent.change(screen.getByLabelText('Número de WhatsApp da empresa'), { target: { value: '' } });
    create();
    expect(await screen.findByText('Escolha ou digite o número de WhatsApp, com código do país e DDD.')).toBeTruthy();
    expect(saves()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Número de WhatsApp da empresa'), { target: { value: '__other__' } });
    const typed = screen.getAllByLabelText('Número de WhatsApp da empresa').find((e) => e.tagName === 'INPUT')!;
    fireEvent.change(typed, { target: { value: '+55 21 97777-6666' } });
    create();
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(bodyOfSave().config.end.whatsappNumber).toBe('5521977776666');
  });

  it('does not turn the button on when no number is connected', async () => {
    h.qr = null;
    open();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/whatsapp/config', expect.anything()));
    expect(screen.getByLabelText('Mostrar o botão Continuar no WhatsApp').getAttribute('aria-checked')).toBe('false');
  });

  it('does not save and says what to fix when something is missing', async () => {
    open();
    await settled();
    create();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Dê um nome ao robô para achá-lo na lista.')).toBeTruthy();
    expect(saves()).toHaveLength(0);
  });

  it('adds questions, reorders them with the arrows, and stops at 10', async () => {
    open();
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar pergunta' }));
    const inputs = () => screen.getAllByLabelText('Texto da pergunta') as HTMLInputElement[];
    fireEvent.change(inputs()[2], { target: { value: 'Qual produto?' } });
    fireEvent.click(screen.getAllByLabelText('Subir a pergunta')[2]);
    expect(inputs().map((i) => i.value)[1]).toBe('Qual produto?');
    fireEvent.click(screen.getAllByLabelText('Descer a pergunta')[1]);
    expect(inputs().map((i) => i.value)[2]).toBe('Qual produto?');
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole('button', { name: 'Adicionar pergunta' }));
    expect(inputs()).toHaveLength(10);
    expect((screen.getByRole('button', { name: 'Adicionar pergunta' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Você chegou ao limite de 10 perguntas.')).toBeTruthy();
  });

  it('never reuses a question id, even after removing and adding again', async () => {
    open();
    await settled();
    setName();
    const ids: string[] = [];
    for (let round = 0; round < 3; round++) {
      fireEvent.click(screen.getByRole('button', { name: 'Adicionar pergunta' }));
      const texts = screen.getAllByLabelText('Texto da pergunta') as HTMLInputElement[];
      fireEvent.change(texts[2], { target: { value: `Pergunta ${round}` } });
      create();
      await waitFor(() => expect(saves()).toHaveLength(round + 1));
      const q = JSON.parse(saves()[round][1].body as string).config.questions[2];
      ids.push(q.id);
      fireEvent.click(screen.getAllByLabelText('Remover a pergunta')[2]);
    }
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => /^q[a-z0-9]+$/.test(id) && !/^q\d$/.test(id))).toBe(true);
  });

  it('keeps name and WhatsApp mandatory: no remove button, always required', () => {
    open();
    const removes = screen.getAllByLabelText('Remover a pergunta') as HTMLButtonElement[];
    expect(removes[0].disabled).toBe(true);
    expect(removes[1].disabled).toBe(true);
    expect(screen.getAllByText('Sempre obrigatória')).toHaveLength(2);
  });

  it('builds a button question and a custom-field mapping, with the checker explaining each problem', async () => {
    open();
    await settled();
    setName();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar pergunta' }));
    fireEvent.change(screen.getAllByLabelText('Texto da pergunta')[2], { target: { value: 'Qual interesse?' } });
    fireEvent.change(screen.getAllByLabelText('Tipo de resposta')[0], { target: { value: 'choice' } });
    const buttons = screen.getByLabelText('Botões de resposta, um por linha (de 2 a 6)');
    fireEvent.change(buttons, { target: { value: 'Loja' } });
    create();
    expect(await screen.findByText('Pergunta número 3: coloque de 2 a 6 botões de resposta.')).toBeTruthy();
    fireEvent.change(buttons, { target: { value: 'Loja\nLoja' } });
    create();
    expect(await screen.findByText('Pergunta número 3: os botões de resposta precisam ser diferentes entre si.')).toBeTruthy();
    fireEvent.change(buttons, { target: { value: `Loja\n${'x'.repeat(61)}` } });
    create();
    expect(await screen.findByText('Pergunta número 3: cada botão precisa ter de 1 a 60 caracteres.')).toBeTruthy();
    fireEvent.change(buttons, { target: { value: 'Loja\nSite' } });
    fireEvent.change(screen.getAllByLabelText('Onde a resposta é guardada')[0], { target: { value: 'custom' } });
    create();
    expect(await screen.findByText('Pergunta número 3: escolha o campo do contato que guarda a resposta.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Campo personalizado do contato'), { target: { value: FIELD } });
    create();
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(bodyOfSave().config.questions[2]).toMatchObject({ type: 'choice', options: ['Loja', 'Site'], target: 'custom', customFieldId: FIELD });
  });

  it('checks the addresses and the privacy link before saving', async () => {
    open();
    await settled();
    setName();
    fireEvent.change(screen.getByLabelText('Sites onde o robô pode funcionar'), { target: { value: 'sem espaço.com' } });
    fireEvent.change(screen.getByLabelText('Link da política de privacidade (opcional)'), { target: { value: 'http://x.com' } });
    create();
    expect((await screen.findAllByText(/Endereço de site inválido/)).length).toBeGreaterThan(0);
    expect(screen.getByText('O link da política de privacidade precisa começar com https://')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Sites onde o robô pode funcionar'), {
      target: { value: Array.from({ length: 11 }, (_, i) => `d${i}.com`).join('\n') },
    });
    fireEvent.change(screen.getByLabelText('Link da política de privacidade (opcional)'), { target: { value: '' } });
    create();
    expect(await screen.findByText('Você pode liberar no máximo 10 endereços de site.')).toBeTruthy();
    expect(saves()).toHaveLength(0);
  });

  it('shows what the server refused, translated', async () => {
    saveResponse = () => new Response(JSON.stringify({ error: 'Invalid bot', details: ['at most 10 domains', 'question 3: the question id is invalid'] }), { status: 400 });
    open();
    await settled();
    setName();
    create();
    await waitFor(() => expect(saves()).toHaveLength(1));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Você pode liberar no máximo 10 endereços de site.')).toBeTruthy();
    expect(within(alert).getByText('Pergunta número 3: o identificador da pergunta é inválido.')).toBeTruthy();
  });

  it('explains subdomains and accented domains next to the addresses', () => {
    open();
    expect(screen.getByText(/subdomínio/)).toBeTruthy();
    expect(screen.getByText(/xn--/)).toBeTruthy();
  });

  it('keeps the preview config stable while unrelated fields change (the widget does not reset)', async () => {
    open();
    await settled();
    const before = new Set(h.previews).size;
    fireEvent.change(screen.getByLabelText('Sites onde o robô pode funcionar'), { target: { value: 'loja.com.br' } });
    fireEvent.change(screen.getByLabelText('Nome do robô nesta lista'), { target: { value: 'Outro nome' } });
    expect(new Set(h.previews).size).toBe(before);
    fireEvent.change(screen.getByLabelText('Primeira mensagem do robô'), { target: { value: 'Oi!' } });
    expect(new Set(h.previews).size).toBe(before + 1);
  });

  it('sends the tags along with the destination', async () => {
    open();
    await settled();
    setName();
    fireEvent.click(screen.getByRole('button', { name: /Site/ }));
    create();
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(bodyOfSave()).toMatchObject({ tag_ids: ['t1'] });
  });

  it('edits an existing bot with PATCH and loads its saved settings', async () => {
    open(baseBot());
    expect((screen.getByLabelText('Nome do robô nesta lista') as HTMLInputElement).value).toBe('Robo antigo');
    expect((screen.getByLabelText('Sites onde o robô pode funcionar') as HTMLTextAreaElement).value).toBe('loja.com.br');
    expect((screen.getByLabelText('Primeira mensagem do robô') as HTMLTextAreaElement).value).toBe('Salve');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0][0]).toBe('/api/site-bots/22222222-2222-4222-8222-222222222222');
    expect(saves()[0][1].method).toBe('PATCH');
    expect(bodyOfSave()).toMatchObject({ is_active: false, pipeline_id: 'p1', stage_id: 's1', config: { appearance: { color: '#ff0000' } } });
    // an existing bot keeps its own settings: no WhatsApp number is forced on it
    expect(bodyOfSave().config.end.whatsappEnabled).toBe(false);
  });
});

describe('describeIssue', () => {
  const t = (k: string) => `[${k}]`;
  it('has a translation key for every message the checker can send', () => {
    expect(BOT_ISSUE_KEYS.length).toBeGreaterThan(30);
  });
  it('translates question-prefixed and domain messages, and falls back for unknown ones', () => {
    expect(describeIssue('question 4: answer buttons must be different', t)).toBe('[Question number] 4: [answer buttons must be different]');
    expect(describeIssue('invalid domain: x y', t)).toBe('[Invalid site address]: x y');
    expect(describeIssue('greeting is required', t)).toBe('[greeting is required]');
    expect(describeIssue('something new', t)).toBe('[Some bot settings need attention. Check them and save again.]');
  });
});
