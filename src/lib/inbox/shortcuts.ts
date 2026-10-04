/**
 * Inbox keyboard shortcuts: (key event + context) -> action. Pure, so the
 * rules are unit-tested without a DOM; `useInboxShortcuts` (page) wires it to
 * `keydown` and forwards the action to the list / thread.
 *
 *   j / ArrowDown   next conversation      k / ArrowUp  previous
 *   Enter / o       open the highlighted one
 *   r               focus the reply box    /            quick replies (open thread)
 *                                          /            focus the search (no thread)
 *   Shift+A         Assumir (claim)        e            Resolver + next conversation
 *   h               Adiar (snooze popover)
 *   ?               shortcut help          Esc          leave the field
 *
 * Ctrl/Cmd+K (command palette) is app-wide: see `paletteKey`.
 */

export type ShortcutAction =
  | 'next'
  | 'prev'
  | 'open'
  | 'focusComposer'
  | 'claim'
  | 'resolve'
  | 'snooze'
  | 'focusSearch'
  | 'quickReplies'
  | 'help'
  | 'blur'

/**
 * What has focus:
 *  - typing: input / textarea / select / contenteditable — keys are text;
 *  - interactive: button, link, menu item, tab… — Enter / Space belong to it;
 *  - other: the page body or a plain container.
 */
export type TargetKind = 'typing' | 'interactive' | 'other'

export interface ShortcutKeyEvent {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  /** Key auto-repeat (held key): never triggers an action. */
  repeat?: boolean
  target: TargetKind
}

export interface ShortcutContext {
  /** A dialog / menu / popover is open: it owns the keyboard (and Esc). */
  overlayOpen: boolean
  /** A conversation is open in the thread. */
  hasActive: boolean
  /** `conversationHeaderActions(...).claim.enabled` for the open thread. */
  canClaim: boolean
  /** `conversationHeaderActions(...).close.enabled` and the thread is not resolved. */
  canResolve: boolean
  /** `conversationHeaderActions(...).snooze.enabled` for the open thread (079). */
  canSnooze?: boolean
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
// AUDIO / VIDEO: a focused media element keeps Enter / arrows (seek, play).
const INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY', 'AUDIO', 'VIDEO'])
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'checkbox',
  'switch',
  'radio',
  'combobox',
  'slider',
])

/** Classify `document.activeElement` / `event.target` (duck-typed, DOM-free). */
export function classifyTarget(
  el: { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null | undefined,
): TargetKind {
  if (!el) return 'other'
  const tag = (el.tagName ?? '').toUpperCase()
  if (TYPING_TAGS.has(tag) || el.isContentEditable) return 'typing'
  const role = el.getAttribute?.('role')
  if (INTERACTIVE_TAGS.has(tag) || (role && INTERACTIVE_ROLES.has(role))) return 'interactive'
  return 'other'
}

export function resolveShortcut(e: ShortcutKeyEvent, ctx: ShortcutContext): ShortcutAction | null {
  if (e.isComposing || e.repeat) return null
  // Esc inside a field hands the keyboard back to the shortcuts.
  if (e.key === 'Escape') return e.target === 'typing' && !ctx.overlayOpen ? 'blur' : null
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.target === 'typing' || ctx.overlayOpen) return null

  const key = e.key
  // Shift only where it is part of the shortcut ("?", Shift+A); other
  // shifted letters are ignored.
  if (e.shiftKey && key !== '?' && key !== 'A') return null

  switch (key) {
    case 'j':
    case 'ArrowDown':
      return e.target === 'interactive' && key === 'ArrowDown' ? null : 'next'
    case 'k':
    case 'ArrowUp':
      return e.target === 'interactive' && key === 'ArrowUp' ? null : 'prev'
    case 'Enter':
      // A focused button / link activates itself; only the bare page opens.
      return e.target === 'other' ? 'open' : null
    case 'o':
      return 'open'
    case '/':
      return ctx.hasActive ? 'quickReplies' : 'focusSearch'
    case '?':
      return 'help'
    case 'r':
      return ctx.hasActive ? 'focusComposer' : null
    case 'A':
      // Shift+A only (a bare "A" is Caps Lock typing, not a shortcut).
      return e.shiftKey && ctx.hasActive && ctx.canClaim ? 'claim' : null
    case 'e':
      return ctx.hasActive && ctx.canResolve ? 'resolve' : null
    case 'h':
      return ctx.hasActive && ctx.canSnooze ? 'snooze' : null
    default:
      return null
  }
}

/** Rows of the help dialog (`keys` are shown as key caps; copy is `t()`-ed by the dialog). */
export const SHORTCUT_HELP: { keys: string[]; label: string }[] = [
  { keys: ['j', '↓'], label: 'Next conversation' },
  { keys: ['k', '↑'], label: 'Previous conversation' },
  { keys: ['Enter', 'o'], label: 'Open conversation' },
  { keys: ['r'], label: 'Reply' },
  { keys: ['/'], label: 'Quick replies' },
  { keys: ['Shift', 'A'], label: 'Take the conversation' },
  { keys: ['e'], label: 'Resolve and open the next one' },
  { keys: ['h'], label: 'Snooze conversation' },
  { keys: ['Ctrl', 'K'], label: 'Search or run a command' },
  { keys: ['?'], label: 'Keyboard shortcuts' },
  { keys: ['Esc'], label: 'Leave the field' },
]

/**
 * Conversation to open after "e" resolves `activeId`: the next row in the
 * on-screen order, or null (nothing after it / not in the list) to clear
 * the selection.
 */
export function nextAfterResolve(orderedIds: readonly string[], activeId: string | null): string | null {
  if (!activeId) return null
  const at = orderedIds.indexOf(activeId)
  return at >= 0 ? orderedIds[at + 1] ?? null : null
}

/**
 * Ctrl+K / Cmd+K, app-wide (also inside fields, like any app palette):
 * 'toggle' opens it, or closes it when it is the open overlay; null while
 * another dialog / menu owns the keyboard.
 */
export function paletteKey(
  e: Pick<ShortcutKeyEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat'>,
  ctx: { paletteOpen: boolean; overlayOpen: boolean },
): 'toggle' | null {
  if (e.isComposing || e.repeat || e.altKey || e.shiftKey) return null
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return null
  if (ctx.overlayOpen && !ctx.paletteOpen) return null
  return 'toggle'
}

/** Index reached by moving `dir` from `current` (-1 = nothing highlighted), clamped. */
export function stepIndex(current: number, dir: 1 | -1, length: number): number {
  if (length <= 0) return -1
  if (current < 0) return dir === 1 ? 0 : length - 1
  return Math.min(length - 1, Math.max(0, current + dir))
}

/** Window event that carries a list / thread shortcut to whichever component owns it. */
export const INBOX_SHORTCUT_EVENT = 'inbox:shortcut'

export function dispatchInboxShortcut(action: ShortcutAction): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ShortcutAction>(INBOX_SHORTCUT_EVENT, { detail: action }))
}

/**
 * Shift+A / "e" / "h" / "r" / "/" act on the OPEN conversation. While the j/k cursor sits on
 * a different row (`cursorPending`), the first press opens that row instead
 * (Enter semantics), so the key never hits a conversation the agent is not
 * looking at.
 */
export function redirectForPendingCursor(action: ShortcutAction, cursorPending: boolean): ShortcutAction {
  return cursorPending &&
    (action === 'claim' || action === 'resolve' || action === 'snooze' || action === 'focusComposer' || action === 'quickReplies')
    ? 'open'
    : action
}

/** Agents can turn the single-key shortcuts off (WCAG 2.1.4); device-scoped. */
export const SHORTCUTS_ENABLED_KEY = 'wacrm:inbox:shortcuts-enabled'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** On unless the agent turned them off. */
export function readShortcutsEnabled(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(SHORTCUTS_ENABLED_KEY) !== 'false'
  } catch {
    return true
  }
}

export function writeShortcutsEnabled(enabled: boolean, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(SHORTCUTS_ENABLED_KEY, String(enabled))
  } catch {
    // best-effort
  }
}
