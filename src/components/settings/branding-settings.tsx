'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Check, ImagePlus, Loader2, MessageSquare, Paintbrush, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import {
  BRANDING_LIMITS,
  BRANDING_PALETTE,
  DEFAULT_APP_NAME,
  isBrandingActive,
  normalizeHexColor,
  primaryForeground,
  type Branding,
} from '@/lib/branding';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';

const BUCKET = 'account-branding';

function extFor(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/svg+xml') return 'svg';
  return 'png';
}

/**
 * Settings → Marca (spec round 2 §6): app name, logo (light / dark
 * preview), primary colour (palette + hex) and "restore defaults".
 * Admin+, module `white_label`. Saves through PUT /api/account/branding
 * (audited); the logo goes to the public `account-branding` bucket under
 * `account-<id>/logo.<ext>`.
 */
export function BrandingSettings() {
  const supabase = useMemo(() => createClient(), []);
  const { t } = useLanguage();
  const { accountId, canManageMembers, profileLoading, branding, refreshAccount } = useAuth();
  const entitlements = useEntitlements();
  const moduleOn = entitlements.modules.white_label;

  const [appName, setAppName] = useState(branding.app_name);
  const [color, setColor] = useState(branding.primary_color ?? '');
  const [logoUrl, setLogoUrl] = useState<string | null>(branding.logo_url);
  const [pendingLogo, setPendingLogo] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Re-seed when the account row (re)loads.
  useEffect(() => {
    setAppName(branding.app_name);
    setColor(branding.primary_color ?? '');
    setLogoUrl(branding.logo_url);
    setPendingLogo(null);
    setPendingPreview(null);
    setRemoveLogo(false);
  }, [branding]);

  useEffect(() => {
    if (!pendingLogo) {
      setPendingPreview(null);
      return;
    }
    const url = URL.createObjectURL(pendingLogo);
    setPendingPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingLogo]);

  const normalizedColor = color.trim() ? normalizeHexColor(color) : null;
  const colorValid = color.trim() === '' || normalizedColor !== null;
  const nameValid = appName.trim().length <= BRANDING_LIMITS.app_name.max;

  const previewLogo = removeLogo ? null : pendingPreview ?? logoUrl;
  const previewName = appName.trim() || DEFAULT_APP_NAME;
  const previewColor = normalizedColor ?? '#7c3aed';

  const dirty =
    appName.trim() !== branding.app_name ||
    (normalizedColor ?? null) !== branding.primary_color ||
    pendingLogo !== null ||
    (removeLogo && branding.logo_url !== null);

  const current: Branding = { app_name: branding.app_name, logo_url: branding.logo_url, primary_color: branding.primary_color };
  const canRestore = isBrandingActive(current) || dirty;

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!(BRANDING_LIMITS.logo.mimeTypes as readonly string[]).includes(file.type)) {
      toast.error(t('Use a PNG, SVG or WebP image.'));
      return;
    }
    if (file.size > BRANDING_LIMITS.logo.maxBytes) {
      toast.error(t('The logo must be 512 KB or smaller.'));
      return;
    }
    setPendingLogo(file);
    setRemoveLogo(false);
  }

  async function save(patch?: { app_name: null; logo_url: null; primary_color: null }) {
    if (!accountId) return;
    setSaving(true);
    try {
      let nextLogo: string | null | undefined = undefined;
      if (patch) {
        nextLogo = null;
      } else if (pendingLogo) {
        const path = `account-${accountId}/logo-${Date.now()}.${extFor(pendingLogo.type)}`;
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, pendingLogo, {
          cacheControl: '3600',
          upsert: true,
          contentType: pendingLogo.type,
        });
        if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
        nextLogo = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      } else if (removeLogo) {
        nextLogo = null;
      }

      const body = patch ?? {
        app_name: appName.trim() || null,
        primary_color: normalizedColor,
        ...(nextLogo !== undefined ? { logo_url: nextLogo } : {}),
      };
      const res = await fetch('/api/account/branding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `HTTP ${res.status}`);
      }
      await refreshAccount();
      toast.success(patch ? t('Default branding restored') : t('Branding saved'));
    } catch (err) {
      console.error('[branding] save failed:', err);
      toast.error(t('Could not save branding'));
    } finally {
      setSaving(false);
    }
  }

  // ---- gates ---------------------------------------------------------
  if (profileLoading || !entitlements.ready) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('Branding')} />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      </section>
    );
  }

  if (!canManageMembers) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('Branding')} />
        <Alert className="border-border bg-card">
          <AlertTitle className="mb-1 text-foreground">{t('Admins only')}</AlertTitle>
          <AlertDescription className="text-sm text-muted-foreground">
            {t('Only account admins can change the branding.')}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  if (!moduleOn) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t('Branding')}
          description={t('Your own name, logo and colour across the app for every member of the account.')}
        />
        <Alert className="border-border bg-card">
          <AlertTitle className="mb-1 text-foreground">{t('Module not included in your plan')}</AlertTitle>
          <AlertDescription className="text-sm text-muted-foreground">
            {t('White-label branding is not part of your current plan. Get in touch with the SempreCRM team to add it.')}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const disabled = saving;

  return (
    <section className="max-w-4xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('Branding')}
        description={t('Your own name, logo and colour across the app for every member of the account.')}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !canRestore}
              onClick={() => save({ app_name: null, logo_url: null, primary_color: null })}
            >
              <RotateCcw className="size-3.5" />
              {t('Restore defaults')}
            </Button>
            <Button
              size="sm"
              disabled={disabled || !dirty || !colorValid || !nameValid}
              onClick={() => save()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {t('Save')}
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <div className="grid gap-4">
          {/* Name --------------------------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t('App name')}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('Shown in the sidebar, the header and the browser tab title.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="branding-name" className="text-foreground">
                {t('Name')}
              </Label>
              <Input
                id="branding-name"
                value={appName}
                maxLength={BRANDING_LIMITS.app_name.max}
                placeholder={DEFAULT_APP_NAME}
                onChange={(e) => setAppName(e.target.value)}
                disabled={disabled}
                aria-invalid={!nameValid || undefined}
                className="bg-card text-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {appName.trim().length}/{BRANDING_LIMITS.app_name.max}
              </p>
            </CardContent>
          </Card>

          {/* Logo --------------------------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t('Logo')}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('Square works best. PNG, SVG or WebP up to 512 KB; it replaces the default mark in the sidebar.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept={BRANDING_LIMITS.logo.mimeTypes.join(',')}
                className="hidden"
                onChange={onPickFile}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus className="size-3.5" />
                {previewLogo ? t('Replace logo') : t('Upload logo')}
              </Button>
              {previewLogo ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    setPendingLogo(null);
                    setRemoveLogo(true);
                  }}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                  {t('Remove logo')}
                </Button>
              ) : null}
              {pendingLogo ? (
                <span className="text-xs text-muted-foreground">
                  {pendingLogo.name} · {Math.ceil(pendingLogo.size / 1024)} KB
                </span>
              ) : null}
            </CardContent>
          </Card>

          {/* Colour ------------------------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Paintbrush className="size-4 text-primary" />
                {t('Primary colour')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('Buttons, links and highlights. Each member keeps their own light or dark mode.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('Palette')}>
                {BRANDING_PALETTE.map((swatch) => {
                  const selected = normalizedColor === swatch.hex;
                  return (
                    <button
                      key={swatch.hex}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={t(swatch.name)}
                      title={t(swatch.name)}
                      disabled={disabled}
                      onClick={() => setColor(swatch.hex)}
                      className={cn(
                        'flex size-8 items-center justify-center rounded-full border-2 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                        selected ? 'border-foreground' : 'border-transparent',
                      )}
                      style={{ backgroundColor: swatch.hex }}
                    >
                      {selected ? (
                        <Check className="size-4" style={{ color: primaryForeground(swatch.hex) }} />
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-2">
                  <Label htmlFor="branding-color" className="text-foreground">
                    {t('Hex colour')}
                  </Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={t('Pick a colour')}
                      value={normalizedColor ?? '#7c3aed'}
                      disabled={disabled}
                      onChange={(e) => setColor(e.target.value)}
                      className="size-8 cursor-pointer rounded-md border border-border bg-card p-0.5"
                    />
                    <Input
                      id="branding-color"
                      value={color}
                      placeholder="#7c3aed"
                      onChange={(e) => setColor(e.target.value)}
                      disabled={disabled}
                      aria-invalid={!colorValid || undefined}
                      className="w-36 bg-card font-mono text-foreground"
                    />
                  </div>
                </div>
                {color.trim() ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => setColor('')}
                    className="text-muted-foreground"
                  >
                    {t('Use theme colour')}
                  </Button>
                ) : null}
              </div>
              {!colorValid ? (
                <p className="text-xs text-destructive">{t('Enter a colour like #7c3aed.')}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {normalizedColor
                    ? t('Overrides the accent theme for everyone in the account.')
                    : t('Empty keeps the theme each member picked under Appearance.')}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Preview --------------------------------------------------------- */}
        <Card className="lg:sticky lg:top-4">
          <CardHeader>
            <CardTitle className="text-foreground">{t('Preview')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('How the sidebar header looks in light and dark mode.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {(['light', 'dark'] as const).map((mode) => (
              <div
                key={mode}
                className={cn(
                  'rounded-lg border p-3',
                  mode === 'light'
                    ? 'border-slate-200 bg-white text-slate-900'
                    : 'border-slate-800 bg-slate-950 text-slate-50',
                )}
              >
                <div className="flex items-center gap-2">
                  {previewLogo ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local preview / remote upload
                    <img src={previewLogo} alt="" className="h-8 w-8 rounded-lg object-contain" />
                  ) : (
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-lg"
                      style={{ backgroundColor: previewColor, color: primaryForeground(previewColor) }}
                    >
                      <MessageSquare className="h-4 w-4" />
                    </div>
                  )}
                  <span className="truncate text-sm font-semibold">{previewName}</span>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <span
                    className="inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium"
                    style={{ backgroundColor: previewColor, color: primaryForeground(previewColor) }}
                  >
                    {t('Primary button')}
                  </span>
                  <span
                    className="inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium"
                    style={{ backgroundColor: `${previewColor}1f`, color: previewColor }}
                  >
                    {t('Active item')}
                  </span>
                </div>
                <p className={cn('mt-2 text-[10px] uppercase tracking-wider', mode === 'light' ? 'text-slate-500' : 'text-slate-400')}>
                  {mode === 'light' ? t('Light') : t('Dark')}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
