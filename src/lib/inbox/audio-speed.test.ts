import { describe, expect, it } from 'vitest'
import { AUDIO_SPEED_KEY, formatClock, nextSpeed, readSpeed, speedLabel, writeSpeed } from './audio-speed'

function memory(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v
    },
  }
}

describe('audio speed', () => {
  it('cycles 1 -> 1.5 -> 2 -> 1', () => {
    expect(nextSpeed(1)).toBe(1.5)
    expect(nextSpeed(1.5)).toBe(2)
    expect(nextSpeed(2)).toBe(1)
    expect(nextSpeed(3)).toBe(1) // unknown value restarts at 1x
    expect(speedLabel(1.5)).toBe('1.5×')
  })

  it('persists and restores the choice', () => {
    const store = memory()
    expect(readSpeed(store)).toBe(1)
    writeSpeed(2, store)
    expect(store.data[AUDIO_SPEED_KEY]).toBe('2')
    expect(readSpeed(store)).toBe(2)
  })

  it('ignores garbage and survives throwing / missing storage', () => {
    expect(readSpeed(memory({ [AUDIO_SPEED_KEY]: '7' }))).toBe(1)
    expect(readSpeed(memory({ [AUDIO_SPEED_KEY]: 'abc' }))).toBe(1)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(readSpeed(broken)).toBe(1)
    expect(() => writeSpeed(1.5, broken)).not.toThrow()
    expect(readSpeed(null)).toBe(1)
    expect(() => writeSpeed(1.5, null)).not.toThrow()
  })
})

describe('formatClock', () => {
  it('formats minutes and hours, and unknown durations', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(7.9)).toBe('0:07')
    expect(formatClock(125)).toBe('2:05')
    expect(formatClock(3723)).toBe('1:02:03')
    expect(formatClock(Infinity)).toBe('--:--')
    expect(formatClock(NaN)).toBe('--:--')
  })
})
