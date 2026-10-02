import { describe, expect, it } from 'vitest'

import { addRecent, foldText, matchScore, rankItems, readRecents, rememberRecent, stepOption, RECENTS_MAX, type RecentEntry } from './command-palette'

describe('matching and ranking', () => {
  it('folds accents and case', () => {
    expect(foldText('  Configurações ')).toBe('configuracoes')
    expect(matchScore('config', 'Configurações')).toBe(0)
  })

  it('prefers prefix, then word start, then substring, then keywords', () => {
    expect(matchScore('caixa', 'Caixa de entrada')).toBe(0)
    expect(matchScore('entr', 'Caixa de entrada')).toBe(1)
    expect(matchScore('ntrad', 'Caixa de entrada')).toBe(2)
    expect(matchScore('inbox', 'Caixa de entrada', 'inbox conversas')).toBe(3)
    expect(matchScore('zzz', 'Caixa de entrada')).toBeNull()
    expect(matchScore('', 'Anything')).toBe(0)
  })

  it('ranks best first and keeps the original order on ties', () => {
    const items = [
      { label: 'Nova tarefa' },
      { label: 'Tarefas' },
      { label: 'Agenda', keywords: 'tarefas eventos' },
      { label: 'Painel' },
    ]
    expect(rankItems(items, 'tar').map((x) => x.label)).toEqual(['Tarefas', 'Nova tarefa', 'Agenda'])
    expect(rankItems(items, '').map((x) => x.label)).toEqual(items.map((x) => x.label))
    expect(rankItems(items, 'xyz')).toEqual([])
  })
})

describe('stepOption', () => {
  it('wraps around and starts at the edges', () => {
    expect(stepOption(0, 1, 3)).toBe(1)
    expect(stepOption(2, 1, 3)).toBe(0)
    expect(stepOption(0, -1, 3)).toBe(2)
    expect(stepOption(-1, 1, 3)).toBe(0)
    expect(stepOption(-1, -1, 3)).toBe(2)
    expect(stepOption(0, 1, 0)).toBe(-1)
  })
})

describe('recents', () => {
  const page = (n: number): RecentEntry => ({ kind: 'page', href: `/p${n}`, label: `P${n}` })

  it('newest first, deduplicated by link, capped', () => {
    let list: RecentEntry[] = []
    for (let i = 1; i <= 7; i++) list = addRecent(list, page(i))
    expect(list.map((x) => x.href)).toEqual(['/p7', '/p6', '/p5', '/p4', '/p3'])
    expect(list).toHaveLength(RECENTS_MAX)
    list = addRecent(list, { ...page(5), label: 'renamed' })
    expect(list.map((x) => x.href)).toEqual(['/p5', '/p7', '/p6', '/p4', '/p3'])
    expect(list[0].label).toBe('renamed')
  })

  it('stores per user and survives broken / hostile storage', () => {
    const data: Record<string, string> = {}
    const st = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) }
    rememberRecent('u1', { kind: 'conversation', href: '/inbox?c=1', label: 'Ana' }, st)
    expect(readRecents('u1', st)).toEqual([{ kind: 'conversation', href: '/inbox?c=1', label: 'Ana' }])
    expect(readRecents('u2', st)).toEqual([])
    expect(readRecents(null, st)).toEqual([])

    data['semprecrm:palette:recent:u3'] = '{not json'
    expect(readRecents('u3', st)).toEqual([])
    data['semprecrm:palette:recent:u4'] = JSON.stringify([
      { kind: 'page', href: 'https://evil.example', label: 'x' },
      { kind: 'page', href: '//evil.example', label: 'x' },
      { kind: 'other', href: '/a', label: 'x' },
      { kind: 'page', href: '/ok', label: 'Ok' },
    ])
    expect(readRecents('u4', st)).toEqual([{ kind: 'page', href: '/ok', label: 'Ok' }])

    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(readRecents('u1', throwing)).toEqual([])
    expect(() => rememberRecent('u1', page(1), throwing)).not.toThrow()
  })
})
