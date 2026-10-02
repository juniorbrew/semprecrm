import { describe, expect, it } from 'vitest'
import { classifyTarget, nextAfterResolve, paletteKey, readShortcutsEnabled, redirectForPendingCursor, resolveShortcut, stepIndex, writeShortcutsEnabled, SHORTCUTS_ENABLED_KEY, type ShortcutContext, type ShortcutKeyEvent } from './shortcuts'

const ctx: ShortcutContext = { overlayOpen: false, hasActive: true, canClaim: true, canResolve: true }
const key = (k: string, over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({ key: k, target: 'other', ...over })

describe('resolveShortcut', () => {
  it('maps the documented keys', () => {
    const map: Record<string, string> = {
      j: 'next', ArrowDown: 'next', k: 'prev', ArrowUp: 'prev', Enter: 'open', o: 'open',
      r: 'focusComposer', e: 'resolve', '/': 'quickReplies',
    }
    for (const [k, action] of Object.entries(map)) expect(resolveShortcut(key(k), ctx)).toBe(action)
    expect(resolveShortcut(key('?', { shiftKey: true }), ctx)).toBe('help')
    expect(resolveShortcut(key('A', { shiftKey: true }), ctx)).toBe('claim')
  })

  it('claim is Shift+A only; "/" searches when no thread is open', () => {
    expect(resolveShortcut(key('a'), ctx)).toBeNull()
    // Caps Lock "A" without Shift is typing, not a shortcut.
    expect(resolveShortcut(key('A'), ctx)).toBeNull()
    expect(resolveShortcut(key('/'), { ...ctx, hasActive: false })).toBe('focusSearch')
  })

  it('never fires while typing; Esc leaves the field', () => {
    for (const k of ['j', 'a', 'e', '/', '?', 'Enter']) {
      expect(resolveShortcut(key(k, { target: 'typing' }), ctx)).toBeNull()
    }
    expect(resolveShortcut(key('A', { shiftKey: true, target: 'typing' }), ctx)).toBeNull()
    expect(resolveShortcut(key('Escape', { target: 'typing' }), ctx)).toBe('blur')
    expect(resolveShortcut(key('Escape'), ctx)).toBeNull()
  })

  it('ignores modifier combinations and IME composition', () => {
    expect(resolveShortcut(key('r', { ctrlKey: true }), ctx)).toBeNull()
    expect(resolveShortcut(key('r', { metaKey: true }), ctx)).toBeNull()
    expect(resolveShortcut(key('a', { altKey: true }), ctx)).toBeNull()
    expect(resolveShortcut(key('J', { shiftKey: true }), ctx)).toBeNull()
    expect(resolveShortcut(key('j', { isComposing: true }), ctx)).toBeNull()
  })

  it('leaves the keyboard to open overlays', () => {
    const open = { ...ctx, overlayOpen: true }
    expect(resolveShortcut(key('j'), open)).toBeNull()
    expect(resolveShortcut(key('?', { shiftKey: true }), open)).toBeNull()
    expect(resolveShortcut(key('Escape', { target: 'typing' }), open)).toBeNull()
  })

  it('Shift+A and e only when the header rules allow them (viewers: never)', () => {
    const shiftA = key('A', { shiftKey: true })
    expect(resolveShortcut(shiftA, { ...ctx, canClaim: false })).toBeNull()
    expect(resolveShortcut(key('e'), { ...ctx, canResolve: false })).toBeNull()
    expect(resolveShortcut(shiftA, { ...ctx, hasActive: false })).toBeNull()
    expect(resolveShortcut(key('e', { ctrlKey: true }), ctx)).toBeNull()
    expect(resolveShortcut(key('r'), { ...ctx, hasActive: false })).toBeNull()
    expect(resolveShortcut(key('j'), { ...ctx, hasActive: false })).toBe('next')
  })

  it('a focused button / menu keeps Enter and the arrows', () => {
    expect(resolveShortcut(key('Enter', { target: 'interactive' }), ctx)).toBeNull()
    expect(resolveShortcut(key('ArrowDown', { target: 'interactive' }), ctx)).toBeNull()
    expect(resolveShortcut(key('j', { target: 'interactive' }), ctx)).toBe('next')
  })
})

describe('classifyTarget', () => {
  it('recognises fields, contenteditable and interactive elements', () => {
    expect(classifyTarget({ tagName: 'TEXTAREA' })).toBe('typing')
    expect(classifyTarget({ tagName: 'input' })).toBe('typing')
    expect(classifyTarget({ tagName: 'DIV', isContentEditable: true })).toBe('typing')
    expect(classifyTarget({ tagName: 'BUTTON' })).toBe('interactive')
    expect(classifyTarget({ tagName: 'DIV', getAttribute: (n) => (n === 'role' ? 'menuitem' : null) })).toBe('interactive')
    expect(classifyTarget({ tagName: 'BODY' })).toBe('other')
    expect(classifyTarget(null)).toBe('other')
  })
})

describe('stepIndex', () => {
  it('starts at the edges and clamps', () => {
    expect(stepIndex(-1, 1, 5)).toBe(0)
    expect(stepIndex(-1, -1, 5)).toBe(4)
    expect(stepIndex(4, 1, 5)).toBe(4)
    expect(stepIndex(0, -1, 5)).toBe(0)
    expect(stepIndex(2, 1, 5)).toBe(3)
    expect(stepIndex(0, 1, 0)).toBe(-1)
  })
})

describe('review fixes', () => {
  it('ignores key auto-repeat', () => {
    expect(resolveShortcut(key('e', { repeat: true }), ctx)).toBeNull()
    expect(resolveShortcut(key('j', { repeat: true }), ctx)).toBeNull()
  })

  it('a focused audio / video keeps Enter and the arrows', () => {
    expect(classifyTarget({ tagName: 'AUDIO' })).toBe('interactive')
    expect(resolveShortcut(key('Enter', { target: classifyTarget({ tagName: 'AUDIO' }) }), ctx)).toBeNull()
    expect(resolveShortcut(key('ArrowUp', { target: 'interactive' }), ctx)).toBeNull()
  })

  it('a / e / r open the highlighted row first when the cursor is not on the open thread', () => {
    expect(redirectForPendingCursor('claim', true)).toBe('open')
    expect(redirectForPendingCursor('resolve', true)).toBe('open')
    expect(redirectForPendingCursor('focusComposer', true)).toBe('open')
    expect(redirectForPendingCursor('quickReplies', true)).toBe('open')
    expect(redirectForPendingCursor('claim', false)).toBe('claim')
    expect(redirectForPendingCursor('next', true)).toBe('next')
  })

  it('the on/off preference persists and defaults to on', () => {
    const data: Record<string, string> = {}
    const st = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) }
    expect(readShortcutsEnabled(st)).toBe(true)
    writeShortcutsEnabled(false, st)
    expect(data[SHORTCUTS_ENABLED_KEY]).toBe('false')
    expect(readShortcutsEnabled(st)).toBe(false)
    expect(readShortcutsEnabled(null)).toBe(true)
  })
})

describe('nextAfterResolve', () => {
  it('opens the next row, or nothing at the end / outside the list', () => {
    const ids = ['a', 'b', 'c']
    expect(nextAfterResolve(ids, 'a')).toBe('b')
    expect(nextAfterResolve(ids, 'b')).toBe('c')
    expect(nextAfterResolve(ids, 'c')).toBeNull()
    expect(nextAfterResolve(ids, 'x')).toBeNull()
    expect(nextAfterResolve(ids, null)).toBeNull()
    expect(nextAfterResolve([], 'a')).toBeNull()
  })
})

describe('paletteKey', () => {
  const closed = { paletteOpen: false, overlayOpen: false }
  it('Ctrl+K and Cmd+K toggle the palette, even from a field', () => {
    expect(paletteKey({ key: 'k', ctrlKey: true }, closed)).toBe('toggle')
    expect(paletteKey({ key: 'K', metaKey: true }, closed)).toBe('toggle')
    expect(paletteKey({ key: 'k', ctrlKey: true }, { paletteOpen: true, overlayOpen: true })).toBe('toggle')
  })
  it('ignores other combinations and other open dialogs', () => {
    expect(paletteKey({ key: 'k' }, closed)).toBeNull()
    expect(paletteKey({ key: 'k', ctrlKey: true, shiftKey: true }, closed)).toBeNull()
    expect(paletteKey({ key: 'k', ctrlKey: true, altKey: true }, closed)).toBeNull()
    expect(paletteKey({ key: 'k', ctrlKey: true, repeat: true }, closed)).toBeNull()
    expect(paletteKey({ key: 'j', ctrlKey: true }, closed)).toBeNull()
    expect(paletteKey({ key: 'k', ctrlKey: true }, { paletteOpen: false, overlayOpen: true })).toBeNull()
  })
})
