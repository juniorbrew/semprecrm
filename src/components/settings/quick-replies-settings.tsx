'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Pencil, Plus, Search, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import {
  QUICK_REPLY_SHORTCUT_RE,
  QUICK_REPLY_VARIABLES,
  createQuickReply,
  deleteQuickReply,
  isDuplicateShortcutError,
  listQuickReplies,
  matchQuickReplies,
  updateQuickReply,
  variableToken,
  type QuickReplyVariable,
} from '@/lib/quick-replies';
import type { QuickReply } from '@/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';

/** Soft ceiling — WhatsApp text messages cap at 4096 chars. */
const BODY_MAX = 4096;

const VARIABLE_LABELS: Record<QuickReplyVariable, string> = {
  'contato.nome': 'Contact name',
  'contato.primeiro_nome': 'Contact first name',
  'atendente.nome': 'Agent name',
  empresa: 'Company',
};

type DialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; reply: QuickReply };

/**
 * Configurações → Respostas rápidas: the account's canned responses,
 * inserted in the inbox composer via "/atalho". Table with search,
 * create/edit dialog (shortcut, title, body + variable buttons), delete
 * with confirmation. Agent+ can write — RLS enforces it, the UI mirrors it.
 */
export function QuickRepliesSettings() {
  const supabase = useMemo(() => createClient(), []);
  const { t } = useLanguage();
  const { user, accountId, canSendMessages, profileLoading } = useAuth();
  const readOnly = !canSendMessages;

  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<DialogState>({ mode: 'closed' });
  const [toDelete, setToDelete] = useState<QuickReply | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function reload() {
    if (!accountId) return;
    try {
      setReplies(await listQuickReplies(supabase, accountId));
    } catch (err) {
      console.error(err);
      toast.error(t('Failed to load quick replies'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listQuickReplies(supabase, accountId);
        if (!cancelled) setReplies(rows);
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase]);

  const visible = useMemo(
    () => (search.trim() ? matchQuickReplies(replies, search, replies.length) : replies),
    [replies, search],
  );

  async function handleDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await deleteQuickReply(supabase, toDelete.id);
      setReplies((prev) => prev.filter((r) => r.id !== toDelete.id));
      setToDelete(null);
      toast.success(t('Quick reply deleted'));
    } catch (err) {
      console.error(err);
      toast.error(t('Failed to delete quick reply'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('Quick replies')}
        description={t(
          'Ready-made answers your team inserts in the inbox by typing / followed by the shortcut. Variables fill in the contact, agent and company names.',
        )}
        action={
          !readOnly ? (
            <Button
              size="sm"
              onClick={() => setDialog({ mode: 'create' })}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              {t('New quick reply')}
            </Button>
          ) : null
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Zap className="size-4 text-primary" />
            {t('Library')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('Shortcuts are lower-case, without spaces, and unique in the account.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('Search by shortcut or title')}
              aria-label={t('Search by shortcut or title')}
              className="border-border bg-muted pl-8 text-sm text-foreground"
            />
          </div>

          {loading || profileLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
              ))}
            </div>
          ) : replies.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <Zap className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium text-foreground">{t('No quick replies yet')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('Create the first one — for example /oi with a greeting that uses the contact name.')}
              </p>
              {!readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDialog({ mode: 'create' })}
                  className="mt-3 border-border bg-transparent text-muted-foreground hover:bg-muted"
                >
                  <Plus className="h-3 w-3" />
                  {t('New quick reply')}
                </Button>
              )}
            </div>
          ) : visible.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t('Nothing matches your search.')}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('Shortcut')}</th>
                    <th className="px-3 py-2 font-medium">{t('Title')}</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">{t('Preview')}</th>
                    {!readOnly && <th className="w-20 px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((reply) => (
                    <tr key={reply.id} className="border-t border-border align-top">
                      <td className="whitespace-nowrap px-3 py-2">
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                          /{reply.shortcut}
                        </code>
                      </td>
                      <td className="px-3 py-2 font-medium text-foreground">{reply.title}</td>
                      <td className="hidden max-w-[28ch] truncate px-3 py-2 text-muted-foreground md:table-cell">
                        {reply.body.replace(/\s+/g, ' ')}
                      </td>
                      {!readOnly && (
                        <td className="px-3 py-1.5">
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => setDialog({ mode: 'edit', reply })}
                              aria-label={t('Edit')}
                              title={t('Edit')}
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setToDelete(reply)}
                              aria-label={t('Delete')}
                              title={t('Delete')}
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {readOnly && !loading && (
            <p className="text-xs text-muted-foreground">
              {t('Only agents and admins can change quick replies.')}
            </p>
          )}
        </CardContent>
      </Card>

      {dialog.mode !== 'closed' && accountId && (
        <QuickReplyDialog
          reply={dialog.mode === 'edit' ? dialog.reply : null}
          existing={replies}
          onClose={() => setDialog({ mode: 'closed' })}
          onSave={async (input) => {
            if (dialog.mode === 'edit') {
              const saved = await updateQuickReply(supabase, dialog.reply.id, input);
              setReplies((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
              toast.success(t('Quick reply saved'));
            } else {
              const saved = await createQuickReply(
                supabase,
                { accountId, userId: user?.id ?? null },
                input,
              );
              setReplies((prev) =>
                [...prev, saved].sort((a, b) => a.shortcut.localeCompare(b.shortcut)),
              );
              toast.success(t('Quick reply created'));
            }
            void reload();
          }}
        />
      )}

      <Dialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('Delete quick reply?')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              <code className="font-mono">/{toDelete?.shortcut}</code> — {toDelete?.title}.{' '}
              {t("This can't be undone.")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setToDelete(null)}
              disabled={deleting}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('Cancel')}
            </Button>
            <Button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ------------------------------------------------------------
// Create / edit dialog
// ------------------------------------------------------------

function QuickReplyDialog({
  reply,
  existing,
  onClose,
  onSave,
}: {
  reply: QuickReply | null;
  existing: readonly QuickReply[];
  onClose: () => void;
  onSave: (input: { shortcut: string; title: string; body: string }) => Promise<void>;
}) {
  const { t } = useLanguage();
  const [shortcut, setShortcut] = useState(reply?.shortcut ?? '');
  const [title, setTitle] = useState(reply?.title ?? '');
  const [body, setBody] = useState(reply?.body ?? '');
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const normalizedShortcut = shortcut.trim().toLowerCase();
  const shortcutFormatOk = QUICK_REPLY_SHORTCUT_RE.test(normalizedShortcut);
  const shortcutTaken = existing.some(
    (r) => r.shortcut === normalizedShortcut && r.id !== reply?.id,
  );
  const shortcutError = !shortcutFormatOk
    ? t('Use 1–30 lower-case letters, numbers, "_" or "-" — no spaces.')
    : shortcutTaken
      ? t('This shortcut is already in use.')
      : null;
  const titleError = title.trim() ? null : t('Title is required');
  const bodyError = !body.trim()
    ? t('Body is required')
    : body.length > BODY_MAX
      ? t('Body is too long')
      : null;
  const valid = !shortcutError && !titleError && !bodyError;

  function insertVariable(name: QuickReplyVariable) {
    const token = variableToken(name);
    const el = bodyRef.current;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? start;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  }

  async function submit() {
    setSubmitted(true);
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSave({ shortcut: normalizedShortcut, title, body });
      onClose();
    } catch (err) {
      console.error(err);
      toast.error(
        isDuplicateShortcutError(err)
          ? t('This shortcut is already in use.')
          : t('Failed to save quick reply'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {reply ? t('Edit quick reply') : t('New quick reply')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('Type / plus the shortcut in the inbox composer to insert this text.')}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="qr-shortcut" className="text-foreground">
                {t('Shortcut')}
              </Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-sm text-muted-foreground">
                  /
                </span>
                <Input
                  id="qr-shortcut"
                  value={shortcut}
                  onChange={(e) => setShortcut(e.target.value.toLowerCase())}
                  placeholder={t('e.g. welcome')}
                  maxLength={30}
                  autoFocus={!reply}
                  aria-invalid={submitted && !!shortcutError}
                  className="border-border bg-muted pl-6 font-mono text-sm text-foreground"
                />
              </div>
              {(submitted || shortcut) && shortcutError ? (
                <p className="text-xs text-red-500">{shortcutError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{t('Letters, numbers, "_" and "-".')}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qr-title" className="text-foreground">
                {t('Title')}
              </Label>
              <Input
                id="qr-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('Welcome message')}
                maxLength={80}
                aria-invalid={submitted && !!titleError}
                className="border-border bg-muted text-sm text-foreground"
              />
              {submitted && titleError && <p className="text-xs text-red-500">{titleError}</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="qr-body" className="text-foreground">
                {t('Body')}
              </Label>
              <span
                className={cn(
                  'text-xs tabular-nums',
                  body.length > BODY_MAX ? 'text-red-500' : 'text-muted-foreground',
                )}
              >
                {body.length}/{BODY_MAX}
              </span>
            </div>
            <Textarea
              id="qr-body"
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('Hi {{contato.primeiro_nome}}! This is {{atendente.nome}} from {{empresa}}. How can I help?')}
              rows={5}
              aria-invalid={submitted && !!bodyError}
              className="min-h-28 border-border bg-muted text-sm text-foreground"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{t('Insert variable:')}</span>
              {QUICK_REPLY_VARIABLES.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => insertVariable(name)}
                  title={t(VARIABLE_LABELS[name])}
                  className="rounded-md border border-border bg-card px-2 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:bg-muted"
                >
                  {variableToken(name)}
                </button>
              ))}
            </div>
            {submitted && bodyError && <p className="text-xs text-red-500">{bodyError}</p>}
          </div>

          <DialogFooter className="border-border bg-popover">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('Cancel')}
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {reply ? t('Save') : t('Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
