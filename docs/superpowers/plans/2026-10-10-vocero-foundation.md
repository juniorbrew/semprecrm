# Vocero Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Documentar lacunas reais e impedir envios automáticos quando o registro durável do job falhar.

**Architecture:** Reutilizar `patchJob` e a política existente de retry/checkpoint. Falhar fechado nas gravações, sem novo serviço, tabela ou abstração.

**Tech Stack:** Next.js 16, Supabase, TypeScript, Vitest, npm.

**Spec:** `docs/superpowers/specs/2026-10-10-vocero-evolution-design.md`

## Global Constraints

- Sem novas dependências, migration, acesso à produção ou alterações em `.env`.
- Preservar contratos, tenants, dados e gateway existentes.
- Diagnóstico do banco não pode aparecer na exceção de gravação.
- Código da referência não será copiado nesta entrega.

## Review Focus

- Falha ao persistir resposta preparada: zero mensagens enviadas.
- Checkpoint indisponível ou sem linha: zero envios daquela bolha.
- Queda depois da primeira bolha: retomar apenas a segunda.
- Conclusão do job falha depois do envio: não reenviar mensagem.
- Diagnóstico sensível no erro do banco: exceção genérica.

## Task 1: Auditoria e matriz

**Files:** `docs/verification/vocero-evolution/AUDIT.md` e `ROADMAP.md`.

- [x] Inspecionar versões fixadas dos dois repositórios, instruções locais e recursos existentes.
- [x] Registrar status, evidências, riscos e prioridades; separar inspeção estática de validação real.
- [x] Registrar dependências vulneráveis sem aplicar atualização indiscriminada.

## Task 2: Gravação de jobs falha fechado

**Files:** `src/lib/ai/auto-reply-runtime.ts`, `src/lib/ai/auto-reply-runtime.test.ts`.

**Interfaces:** `patchJob(db, id, patch): Promise<void>` permanece privada; passa a rejeitar erro ou atualização sem linha. `runAutoReplyJob` e `drainAutoReplies` preservam contratos.

- [x] Criar testes de falha ao gravar resposta, checkpoint, segunda bolha, conclusão e zero linhas; usar `FakeDb` existente e falhas injetadas no cliente.
- [x] Executar suite do runtime e confirmar falhas nos novos casos.
- [x] Alterar `patchJob` para retornar somente `id` e exigir exatamente uma linha atualizada; lançar `Error('ai reply job update failed')` nos demais casos.
- [x] Executar suite do runtime e suites relacionadas; confirmar retomada sem duplicar.
- [x] Executar suite completa, lint, tipos, build e revisão independente; registrar evidência e commit da entrega local.

## Próximas entregas

O roteiro maior está em `ROADMAP.md`; não se trata de um plano executável único para todos os subsistemas. Cada fase terá contrato e testes próprios antes da implementação. A execução local desta primeira correção está autorizada pelo pedido explícito de seguir automaticamente em mudanças de baixo risco.
