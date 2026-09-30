/** Voice-message player helpers: playback speed (persisted per device) and the clock text. */

export const AUDIO_SPEEDS = [1, 1.5, 2] as const
export type AudioSpeed = (typeof AUDIO_SPEEDS)[number]

export const AUDIO_SPEED_KEY = 'wacrm:inbox:audio-speed'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // access itself can throw (sandboxed / blocked storage)
  }
}

/** 1x -> 1.5x -> 2x -> 1x. */
export function nextSpeed(current: number): AudioSpeed {
  const i = AUDIO_SPEEDS.indexOf(current as AudioSpeed)
  return AUDIO_SPEEDS[(i + 1) % AUDIO_SPEEDS.length]
}

/** The saved speed, 1 when nothing valid is stored or storage is unavailable. */
export function readSpeed(storage: StorageLike | null = defaultStorage()): AudioSpeed {
  try {
    const raw = Number(storage?.getItem(AUDIO_SPEED_KEY))
    return (AUDIO_SPEEDS as readonly number[]).includes(raw) ? (raw as AudioSpeed) : 1
  } catch {
    return 1
  }
}

/** Best-effort save; never throws. */
export function writeSpeed(speed: AudioSpeed, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(AUDIO_SPEED_KEY, String(speed))
  } catch {
    // Persistence is a convenience.
  }
}

/** "0:07", "12:03", "1:02:03"; "--:--" for an unknown / infinite duration. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function speedLabel(speed: AudioSpeed): string {
  return `${speed}×`
}
