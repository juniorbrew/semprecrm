import { describe, expect, it } from 'vitest'
import { classifyTarget, resolveShortcut, stepIndex, type ShortcutContext, type ShortcutKeyEvent } from './shortcuts'

const ctx: ShortcutContext = { overlayOpen: false, hasActive: true, canClaim: true, canResolve: true }
const key = (k: string, over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({ key: k, target: 'other', ...over })

describe('resolveShortcut', () => {
  it('maps the documented keys', () => {
    const map: Record<string, string> = {
      j: 'next', ArrowDown: 'next', k: 'prev', ArrowUp: 'prev', Enter: 'open', o: 'open',
      r: 'focusComposer', a: 'claim', e: 'resolve', '/': 'focusSearch',
    }
    for (const [k, action] of Object.entries(map)) expect(resolveShortcut(key(k), ctx)).toBe(action)
    expect(resolveShortcut(key('?', { shiftKey: true }), ctx)).toBe('help')
  })

  it('never fires while typing; Esc leaves the field', () => {
    for (const k of ['j', 'a', 'e', '/', '?', 'Enter']) {
      expect(resolveShortcut(key(k, { target: 'typing' }), ctx)).toBeNull()
    }
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

  it('a and e only when the header rules allow them', () => {
    expect(resolveShortcut(key('a'), { ...ctx, canClaim: false })).toBeNull()
    expect(resolveShortcut(key('e'), { ...ctx, canResolve: false })).toBeNull()
    expect(resolveShortcut(key('a'), { ...ctx, hasActive: false })).toBeNull()
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
