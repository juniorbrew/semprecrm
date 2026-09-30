/**
 * Inbox keyboard shortcuts: (key event + context) -> action. Pure, so the
 * rules are unit-tested without a DOM; `useInboxShortcuts` (page) wires it to
 * `keydown` and forwards the action to the list / thread.
 *
 *   j / ArrowDown   next conversation      k / ArrowUp  previous
 *   Enter / o       open the highlighted one
 *   r               focus the reply box    /            focus the search
 *   a               Assumir (claim)        e            Resolver
 *   ?               shortcut help          Esc          leave the field
 */

export type ShortcutAction =
  | 'next'
  | 'prev'
  | 'open'
  | 'focusComposer'
  | 'claim'
  | 'resolve'
  | 'focusSearch'
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
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY'])
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
  if (e.isComposing) return null
  // Esc inside a field hands the keyboard back to the shortcuts.
  if (e.key === 'Escape') return e.target === 'typing' && !ctx.overlayOpen ? 'blur' : null
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.target === 'typing' || ctx.overlayOpen) return null

  const key = e.key
  // Shift only for characters that need it ("?"); shifted letters are ignored.
  if (e.shiftKey && key !== '?') return null

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
      return 'focusSearch'
    case '?':
      return 'help'
    case 'r':
      return ctx.hasActive ? 'focusComposer' : null
    case 'a':
      return ctx.hasActive && ctx.canClaim ? 'claim' : null
    case 'e':
      return ctx.hasActive && ctx.canResolve ? 'resolve' : null
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
  { keys: ['a'], label: 'Take the conversation' },
  { keys: ['e'], label: 'Resolve' },
  { keys: ['/'], label: 'Search conversations' },
  { keys: ['?'], label: 'Keyboard shortcuts' },
  { keys: ['Esc'], label: 'Leave the field' },
]

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
