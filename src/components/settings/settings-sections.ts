import {
  Bell,
  CalendarDays,
  CheckSquare,
  Coins,
  CreditCard,
  FileText,
  LayoutGrid,
  Paintbrush,
  Palette,
  PlugZap,
  ScrollText,
  Shield,
  Tags,
  Timer,
  User,
  UsersRound,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import type { Module } from '@/lib/plans';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'notifications',
  'calendar',
  'whatsapp',
  'templates',
  'fields',
  'deals',
  'tasks',
  'quick_replies',
  'inbox',
  'integrations',
  'audit',
  'branding',
  'members',
  'plan',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
  /** Hidden from the rail / overview for non-admins (admin+ only). */
  adminOnly?: boolean;
  /** Hidden from the rail / overview when the plan does not include this module. */
  module?: Module;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Visão geral', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Seu perfil', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login e segurança', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Aparência', icon: Palette, group: 'account' },
  notifications: { id: 'notifications', label: 'Notificações', icon: Bell, group: 'account' },
  calendar: { id: 'calendar', label: 'Agenda', icon: CalendarDays, group: 'account', module: 'calendar' },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace' },
  templates: { id: 'templates', label: 'Modelos', icon: FileText, group: 'workspace' },
  fields: { id: 'fields', label: 'Campos e etiquetas', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', label: 'Negócios e moeda', icon: Coins, group: 'workspace' },
  tasks: { id: 'tasks', label: 'Tarefas', icon: CheckSquare, group: 'workspace' },
  quick_replies: { id: 'quick_replies', label: 'Respostas rápidas', icon: Zap, group: 'workspace' },
  inbox: { id: 'inbox', label: 'Atendimento', icon: Timer, group: 'workspace', adminOnly: true },
  integrations: { id: 'integrations', label: 'Integrações', icon: Webhook, group: 'workspace', adminOnly: true },
  audit: { id: 'audit', label: 'Auditoria', icon: ScrollText, group: 'workspace', adminOnly: true },
  branding: { id: 'branding', label: 'Marca', icon: Paintbrush, group: 'workspace', adminOnly: true },
  members: { id: 'members', label: 'Membros da equipe', icon: UsersRound, group: 'workspace' },
  plan: { id: 'plan', label: 'Plano', icon: CreditCard, group: 'workspace' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Conta', group: 'account' },
  { label: 'Espaço de trabalho', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Campos e etiquetas" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
