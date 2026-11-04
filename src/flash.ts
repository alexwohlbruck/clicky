/**
 * The original's flash screens, keyframe for keyframe. Times are milliseconds
 * into the sequence; the intro's were hand-timed to `game-music.mp3`.
 */
export interface Frame {
  textStyle?: Partial<Record<'fontSize' | 'transform' | 'visibility', string>>
  /** `true` adds the next letter; `{ interval }` types the rest at that pace. */
  appendLetter?: true | { interval: number }
  /** Strobe period in ms, or null to hold the current colour. */
  flashAnimation?: number | null
  endFlash?: true
}

export type Frames = Record<number, Frame>

export const INTRO: Frames = {
  0: { textStyle: { fontSize: '15em', visibility: 'visible' } },

  326: { appendLetter: true },
  480: { appendLetter: true },

  810: { appendLetter: true },
  975: { appendLetter: true },
  1130: { appendLetter: true },
  1278: { appendLetter: true },

  1611: { textStyle: { fontSize: '10em' } },
  1766: { textStyle: { fontSize: '15em' } },

  2080: { textStyle: { fontSize: '13em' } },
  2234: { textStyle: { fontSize: '11em' } },

  2565: { textStyle: { fontSize: '13em' } },

  2877: { textStyle: { fontSize: '11em' } },
  3070: { textStyle: { fontSize: '10em' } },

  3369: { textStyle: { transform: 'scaleX(1.4)' } },
  3519: { textStyle: { transform: 'scaleX(1)' } },
  3667: { textStyle: { transform: 'scaleY(1.4)' } },
  3839: { textStyle: { transform: 'scaleY(1)' } },

  4163: { textStyle: { fontSize: '12em', transform: 'rotate(-5deg)' } },
  4300: { textStyle: { fontSize: '14em', transform: 'rotate(-10deg)' } },

  4647: { textStyle: { fontSize: '12em', transform: 'rotate(-5deg)' } },
  4840: { textStyle: { fontSize: '9em', transform: 'rotate(0deg)' } },

  5100: { flashAnimation: 315 },

  7665: { flashAnimation: null },
  7666: { flashAnimation: 40 },

  8943: { flashAnimation: null },
  9637: { endFlash: true },
}

export const ROUND_OVER: Frames = {
  0: { flashAnimation: 80, textStyle: { visibility: 'visible', fontSize: '10em' } },
  300: { appendLetter: { interval: 160 } },
  3000: { endFlash: true },
}

export const GAME_OVER: Frames = {
  0: { flashAnimation: 80, textStyle: { visibility: 'visible', fontSize: '10em' } },
  300: { appendLetter: { interval: 160 } },
  3200: { flashAnimation: null },
  3201: { flashAnimation: 40 },
  4400: { flashAnimation: 160 },
  6200: { endFlash: true },
}

/** What a sequence did this frame, so the effects can react to it. */
export type FlashEvent =
  | { type: 'letter'; index: number }
  | { type: 'size' }
  | { type: 'warp' }
  | { type: 'toggle'; dark: boolean; period: number }
  | { type: 'end' }

/**
 * Plays a sequence against a clock (the music's, when there is music) rather
 * than a pile of timeouts, so it can't drift from the beat it was timed to.
 */
export class Flash {
  dark = false
  done = false
  private applied = new Set<number>()
  private typed = 0
  private strobe: { since: number; period: number } | null = null
  private toggles = 0
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
    el.style.cssText = 'visibility: hidden'
  }

  update(ms: number) {
    for (const at of this.times) {
      if (at > ms || this.applied.has(at)) continue
      this.applied.add(at)
      this.apply(this.frames[at]!, at, ms)
      if (this.done) return
    }

    if (this.typing && ms >= this.typing.next) {
      this.append()
      this.typing.next += this.typing.interval
      if (this.typed >= this.text.length) this.typing = null
    }

    if (this.strobe) {
      const toggles = Math.floor((ms - this.strobe.since) / this.strobe.period) + 1
      while (this.toggles < toggles) {
        this.toggles++
        this.switchColors()
      }
    }
  }

  private typing: { next: number; interval: number } | null = null

  private apply(frame: Frame, at: number, ms: number) {
    if (frame.textStyle) {
      const { fontSize, transform, visibility } = frame.textStyle
      if (fontSize) this.el.style.fontSize = `calc(${fontSize} * var(--flash-scale, 1))`
      if (transform !== undefined) this.el.style.transform = transform
      if (visibility) this.el.style.visibility = visibility
      if (fontSize && at > 0) this.emit({ type: 'size' })
      if (transform) this.emit({ type: 'warp' })
    }

    if (frame.appendLetter === true) this.append()
    else if (frame.appendLetter) this.typing = { next: at, interval: frame.appendLetter.interval }

    if (frame.flashAnimation === null) {
      this.strobe = null
    } else if (frame.flashAnimation) {
      this.strobe = { since: at, period: frame.flashAnimation }
      this.toggles = 0
      this.update(ms)
    }

    if (frame.endFlash) {
      this.done = true
      this.strobe = null
      this.el.textContent = ''
      this.emit({ type: 'end' })
    }
  }

  private append() {
    const letter = this.text[this.typed]
    if (letter === undefined) return
    this.el.textContent += letter
    this.emit({ type: 'letter', index: this.typed })
    this.typed++
  }

  /** As in the original: swap black and white, and pump the text size. */
  private switchColors() {
    this.dark = !this.dark
    this.el.style.fontSize = `calc(${this.dark ? '8em' : '6em'} * var(--flash-scale, 1))`
    this.emit({ type: 'toggle', dark: this.dark, period: this.strobe?.period ?? 0 })
  }
}
