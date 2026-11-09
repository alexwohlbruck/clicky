/**
 * The original's flash screens, keyframe for keyframe. Times are milliseconds
 * into the sequence.
 */
export interface Frame {
  textStyle?: { fontSize?: number; transform?: string; visibility?: 'visible' }
  /** `true` adds the next letter; `{ interval }` types the rest at that pace. */
  appendLetter?: true | { interval: number }
  /** Strobe period in ms, or null to hold the current colour. */
  flashAnimation?: number | null
  endFlash?: true
}

export type Frames = Record<number, Frame>

/**
 * `game-music.mp3` runs on a steady grid of notes 159.57 ms apart, the first
 * landing at 353.7 ms, until a silent break from 9288 ms that ends on a hit at
 * 9667 ms (measured from the decoded audio). The original keyframes were timed
 * by ear and sat 5–40 ms off the notes, drifting later as the song went on, so
 * each one is snapped here to the note it was aiming for.
 */
const NOTE = 159.57
const note = (n: number) => Math.round(353.7 + n * NOTE)

/** Sizes are the original's, in em. */
export const INTRO: Frames = {
  0: { textStyle: { fontSize: 15, visibility: 'visible' } },

  // c l . . i c k y — the letters land on the first two notes, then four in a row.
  [note(0)]: { appendLetter: true },
  [note(1)]: { appendLetter: true },

  [note(3)]: { appendLetter: true },
  [note(4)]: { appendLetter: true },
  [note(5)]: { appendLetter: true },
  [note(6)]: { appendLetter: true },

  [note(8)]: { textStyle: { fontSize: 10 } },
  [note(9)]: { textStyle: { fontSize: 15 } },

  [note(11)]: { textStyle: { fontSize: 13 } },
  [note(12)]: { textStyle: { fontSize: 11 } },

  [note(14)]: { textStyle: { fontSize: 13 } },

  [note(16)]: { textStyle: { fontSize: 11 } },
  [note(17)]: { textStyle: { fontSize: 10 } },

  [note(19)]: { textStyle: { transform: 'scaleX(1.4)' } },
  [note(20)]: { textStyle: { transform: 'scaleX(1)' } },
  [note(21)]: { textStyle: { transform: 'scaleY(1.4)' } },
  [note(22)]: { textStyle: { transform: 'scaleY(1)' } },

  [note(24)]: { textStyle: { fontSize: 12, transform: 'rotate(-5deg)' } },
  [note(25)]: { textStyle: { fontSize: 14, transform: 'rotate(-10deg)' } },

  [note(27)]: { textStyle: { fontSize: 12, transform: 'rotate(-5deg)' } },
  [note(28)]: { textStyle: { fontSize: 9, transform: 'rotate(0deg)' } },

  // Strobe on every other note (the original's 315 ms)...
  [note(30)]: { flashAnimation: NOTE * 2 },

  // ...then four flips a note (the original's 40 ms) until the break.
  [note(46)]: { flashAnimation: NOTE / 4 },

  [note(54)]: { flashAnimation: null },
  9667: { endFlash: true },
}

/**
 * How hard the effects layer hits during the intro, 0 to 1. The letters type
 * out in plain black and white like the original; the size pumps bring in a
 * little shake, the warps start to glitch, and the strobes go all the way.
 */
const INTRO_INTENSITY: [ms: number, intensity: number][] = [
  [0, 0],
  [note(7), 0],
  [note(8), 0.12],
  [note(17), 0.3],
  [note(19), 0.4],
  [note(28), 0.6],
  [note(30), 0.7],
  [note(45), 0.85],
  [note(46), 1],
]

export function introIntensity(ms: number) {
  for (let i = 1; i < INTRO_INTENSITY.length; i++) {
    const [t1, v1] = INTRO_INTENSITY[i]!
    if (ms < t1) {
      const [t0, v0] = INTRO_INTENSITY[i - 1]!
      return v0 + ((v1 - v0) * Math.max(0, ms - t0)) / (t1 - t0)
    }
  }
  return 1
}

export const ROUND_OVER: Frames = {
  0: { flashAnimation: 80, textStyle: { visibility: 'visible', fontSize: 10 } },
  300: { appendLetter: { interval: 160 } },
  3000: { endFlash: true },
}

export const GAME_OVER: Frames = {
  0: { flashAnimation: 80, textStyle: { visibility: 'visible', fontSize: 10 } },
  300: { appendLetter: { interval: 160 } },
  3200: { flashAnimation: 40 },
  4400: { flashAnimation: 160 },
  6200: { endFlash: true },
}

/** When a sequence's sounds should land, in ms: its strobes, its letters, its end. */
export interface Cues {
  strobes: { from: number; to: number; period: number }[]
  letters: number[]
  end: number
}

/** Read a sequence's timeline without playing it, so its sound can be scheduled ahead. */
export function cues(frames: Frames, text: string): Cues {
  const times = Object.keys(frames)
    .map(Number)
    .sort((a, b) => a - b)
  const strobes: Cues['strobes'] = []
  const letters: number[] = []
  let strobe: { from: number; period: number } | null = null
  let end = times.at(-1) ?? 0
  for (const at of times) {
    const frame = frames[at]!
    if (frame.appendLetter === true) {
      if (letters.length < text.length) letters.push(at)
    } else if (frame.appendLetter) {
      const { interval } = frame.appendLetter
      for (let i = 0; letters.length < text.length; i++) letters.push(at + i * interval)
    }
    if (frame.flashAnimation !== undefined || frame.endFlash) {
      if (strobe) strobes.push({ ...strobe, to: at })
      strobe = frame.flashAnimation ? { from: at, period: frame.flashAnimation } : null
    }
    if (frame.endFlash) {
      end = at
      break
    }
  }
  return { strobes, letters: letters.filter((at) => at < end), end }
}

/** What a sequence did this frame, so the effects can react to it. */
export type FlashEvent =
  | { type: 'letter'; index: number }
  | { type: 'size' }
  | { type: 'warp' }
  | { type: 'toggle'; dark: boolean; period: number }
  | { type: 'end' }

/** The text is laid out once at this size and scaled on the GPU from there. */
const BASE_EM = 15

/**
 * Plays a sequence against a clock. Everything is worked out from the time
 * each frame rather than stepped by timers, so a slow frame skips ahead
 * instead of falling behind the music.
 */
export class Flash {
  dark = false
  done = false
  private next = 0
  private typed = 0
  private typing: { from: number; interval: number } | null = null
  private strobe: { since: number; period: number; flips: number; base: boolean } | null = null
  private size = BASE_EM
  private transform = ''
  private times: number[]

  constructor(
    private frames: Frames,
    private text: string,
    private el: HTMLElement,
    private emit: (event: FlashEvent) => void,
  ) {
    this.times = Object.keys(frames)
      .map(Number)
      .sort((a, b) => a - b)
    el.textContent = ''
    el.style.visibility = 'hidden'
    this.paint()
  }

  update(ms: number) {
    // Keyframes: a size change or warp fires once a frame, however many were due.
    let sized = false
    let warped = false
    while (this.next < this.times.length && this.times[this.next]! <= ms) {
      const at = this.times[this.next++]!
      const frame = this.frames[at]!
      const { fontSize, transform, visibility } = frame.textStyle ?? {}
      if (fontSize !== undefined) {
        this.size = fontSize
        sized ||= at > 0
      }
      if (transform !== undefined) {
        this.transform = transform
        warped = true
      }
      if (visibility) this.el.style.visibility = visibility

      if (frame.appendLetter === true) this.append()
      else if (frame.appendLetter) this.typing = { from: at, interval: frame.appendLetter.interval }

      if (frame.flashAnimation === null) this.strobe = null
      else if (frame.flashAnimation) this.strobe = { since: at, period: frame.flashAnimation, flips: 0, base: this.dark }

      if (frame.endFlash) {
        this.done = true
        this.strobe = null
        this.el.textContent = ''
        this.emit({ type: 'end' })
        return
      }
    }
    if (sized) this.emit({ type: 'size' })
    if (warped) this.emit({ type: 'warp' })

    if (this.typing) {
      const due = Math.min(this.text.length, Math.floor((ms - this.typing.from) / this.typing.interval) + 1)
      while (this.typed < due) this.append()
      if (this.typed >= this.text.length) this.typing = null
    }

    // The original flipped on every interval tick, the first one immediately,
    // and pumped the size between 8em and 6em with it. Both stick when it stops.
    if (this.strobe) {
      const flips = Math.floor((ms - this.strobe.since) / this.strobe.period) + 1
      if (flips !== this.strobe.flips) {
        this.strobe.flips = flips
        this.dark = flips % 2 === 1 ? !this.strobe.base : this.strobe.base
        this.size = this.dark ? 8 : 6
        this.emit({ type: 'toggle', dark: this.dark, period: this.strobe.period })
      }
    }

    this.paint()
  }

  private paint() {
    const size = this.size
    this.el.style.transform = `${this.transform} scale(${size / BASE_EM})`
    this.el.style.color = this.dark ? 'white' : 'black'
  }

  private append() {
    const letter = this.text[this.typed]
    if (letter === undefined) return
    this.el.textContent += letter
    this.emit({ type: 'letter', index: this.typed })
    this.typed++
  }
}
