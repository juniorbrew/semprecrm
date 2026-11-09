// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { LeadSource } from '@/types';

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acct-1' }) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { phone_number: '+55 11 98888-7777', status: 'connected' } }) }),
      }),
    }),
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The real preview loads /robo.js; it has its own test below.
vi.mock('./site-bot-preview', () => ({ SiteBotPreview: () => <div data-testid="preview" /> }));

import { SiteBotEditor, type BotResources } from './site-bot-editor';

const resources: BotResources = {
  pipelines: [{ id: 'p1', name: 'Vendas' } as never],
  stages: [{ id: 's1', pipeline_id: 'p1', name: 'Novo' } as never],
  tags: [{ id: 't1', name: 'Site', color: '#2563eb' } as never],
  members: [{ user_id: 'u1', full_name: 'Ana', email: 'ana@x.com' } as never],
  customFields: [{ id: '11111111-1111-4111-8111-111111111111', field_name: 'Interesse' } as never],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/whatsapp/config') return new Response(JSON.stringify({ connected: false }), { status: 200 });
    void init;
    return new Response(JSON.stringify({ source: { id: 'new-1', name: 'Robo', kind: 'site_bot', public_key: 'a'.repeat(32) } }), { status: 201 });
  });
  window.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const saves = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/site-bots'));
const bodyOfSave = () => JSON.parse(saves()[0][1].body as string);

function open(source: LeadSource | null = null) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<SiteBotEditor source={source} resources={resources} onClose={onClose} onSaved={onSaved} />);
  return { onSaved, onClose };
}

const setName = (v = 'Robo da Loja') => fireEvent.change(screen.getByLabelText('Nome do robô nesta lista'), { target: { value: v } });

describe('SiteBotEditor', () => {
  it('creates a bot: sends the draft to the server and reports the saved row', async () => {
    const { onSaved, onClose } = open();
    expect(screen.getByTestId('preview')).toBeTruthy();
    setName();
    fireEvent.change(screen.getByLabelText('Lado da tela'), { target: { value: 'left' } });
    fireEvent.change(screen.getByLabelText('Sites onde o robô pode funcionar'), {
      target: { value: 'https://www.MinhaLoja.com.br/contato\nloja.com.br' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
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

  it('does not save and says what to fix when something is missing', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Dê um nome ao robô para achá-lo na lista.')).toBeTruthy();
    expect(saves()).toHaveLength(0);
  });

  it('adds questions, reorders them with the arrows, and stops at 10', async () => {
    open();
    setName();
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

  it('keeps name and WhatsApp mandatory: no remove button, always required', () => {
    open();
    const removes = screen.getAllByLabelText('Remover a pergunta') as HTMLButtonElement[];
    expect(removes[0].disabled).toBe(true);
    expect(removes[1].disabled).toBe(true);
    expect(screen.getAllByText('Sempre obrigatória')).toHaveLength(2);
  });

  it('builds a button question and a custom-field mapping, rejecting duplicate or empty buttons', async () => {
    open();
    setName();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar pergunta' }));
    fireEvent.change(screen.getAllByLabelText('Texto da pergunta')[2], { target: { value: 'Qual interesse?' } });
    fireEvent.change(screen.getAllByLabelText('Tipo de resposta')[0], { target: { value: 'choice' } });
    const buttons = screen.getByLabelText('Botões de resposta, um por linha (de 2 a 6)');
    fireEvent.change(buttons, { target: { value: 'Loja\nLoja' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    expect(await screen.findByText('As opções de resposta precisam ser diferentes entre si.')).toBeTruthy();
    fireEvent.change(buttons, { target: { value: 'Loja\nSite' } });
    fireEvent.change(screen.getAllByLabelText('Onde a resposta é guardada')[0], { target: { value: 'custom' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    expect(await screen.findByText('Escolha o campo do contato que guarda cada resposta.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Campo personalizado do contato'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    const q = bodyOfSave().config.questions[2];
    expect(q).toMatchObject({ type: 'choice', options: ['Loja', 'Site'], target: 'custom', customFieldId: '11111111-1111-4111-8111-111111111111' });
  });

  it('needs a WhatsApp number when the button is on, offering the connected one', async () => {
    open();
    setName();
    fireEvent.click(screen.getByLabelText('Mostrar o botão Continuar no WhatsApp'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    expect(await screen.findByText('Escolha ou digite o número de WhatsApp, com código do país e DDD.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('option', { name: '+5511988887777' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Número de WhatsApp da empresa'), { target: { value: '5511988887777' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(bodyOfSave().config.end).toMatchObject({ whatsappEnabled: true, whatsappNumber: '5511988887777' });
  });

  it('sends the destination, rejects bad addresses and an http privacy link', async () => {
    open();
    setName();
    fireEvent.change(screen.getByLabelText('Sites onde o robô pode funcionar'), { target: { value: 'sem espaço.com' } });
    fireEvent.change(screen.getByLabelText('Link da política de privacidade (opcional)'), { target: { value: 'http://x.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    expect(await screen.findByText('Um dos endereços de site não é válido.')).toBeTruthy();
    expect(screen.getByText('O link da política de privacidade precisa começar com https://')).toBeTruthy();
    expect(saves()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Sites onde o robô pode funcionar'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Link da política de privacidade (opcional)'), { target: { value: '' } });
    const selects = screen.getAllByRole('combobox');
    const pipeline = selects.find((s) => within(s).queryByText('Não criar negócio'))!;
    fireEvent.change(pipeline, { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    expect(await screen.findByText('Escolha a etapa em que os novos negócios começam.')).toBeTruthy();
    const stage = selects.find((s) => within(s).queryByText('Escolha uma etapa'))!;
    fireEvent.change(stage, { target: { value: 's1' } });
    fireEvent.click(screen.getByRole('button', { name: /Site/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(bodyOfSave()).toMatchObject({ pipeline_id: 'p1', stage_id: 's1', tag_ids: ['t1'] });
  });

  it('edits an existing bot with PATCH and loads its saved settings', async () => {
    const source = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Robo antigo',
      is_active: false,
      kind: 'site_bot',
      public_key: 'a'.repeat(32),
      pipeline_id: null,
      stage_id: null,
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
    open(source);
    expect((screen.getByLabelText('Nome do robô nesta lista') as HTMLInputElement).value).toBe('Robo antigo');
    expect((screen.getByLabelText('Sites onde o robô pode funcionar') as HTMLTextAreaElement).value).toBe('loja.com.br');
    expect((screen.getByLabelText('Primeira mensagem do robô') as HTMLTextAreaElement).value).toBe('Salve');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0][0]).toBe('/api/site-bots/22222222-2222-4222-8222-222222222222');
    expect(saves()[0][1].method).toBe('PATCH');
    expect(bodyOfSave()).toMatchObject({ is_active: false, config: { appearance: { color: '#ff0000' } } });
  });
});
