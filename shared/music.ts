/**
 * What the server worked out about a track by listening to it, and the
 * questions the game asks of it. Times are milliseconds into the track.
 */
export interface Analysis {
  version: typeof ANALYSIS_VERSION
  bpm: number
  /** Every beat, in order. */
  beats: number[]
  /** Which beats start a bar, as indices into `beats`, in order. Usually four apart, but not always: the bar line is followed through the song. */
  bars: number[]
  /** The song's key. */
  key: Key
  /** Stretches with one character, and how intense each is, 0 to 1. */
  sections: { start: number; end: number; energy: number }[]
  /** Where a quiet stretch breaks into a loud one. */
  drops: number[]
}

/** A key: its tonic as a pitch class (0 is C, 9 is A), and major or minor. */
export interface Key {
  tonic: number
  minor: boolean
}

/** Bumped when the analysis changes, so cached ones are redone. */
export const ANALYSIS_VERSION = 5 as const

/** Index of the last beat at or before `ms`, or -1 before the first. */
export function beatIndex(analysis: Analysis, ms: number) {
  const { beats } = analysis
  let lo = 0
  let hi = beats.length - 1
  if (hi < 0 || ms < beats[0]!) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (beats[mid]! <= ms) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function isDownbeat(analysis: Analysis, index: number) {
  const { bars } = analysis
  let lo = 0
  let hi = bars.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid] === index) return true
    if (bars[mid]! < index) lo = mid + 1
    else hi = mid - 1
  }
  return false
}

/** The first beat (or downbeat) at or after `ms`, or null past the last. */
export function nextBeat(analysis: Analysis, ms: number, downbeat = false): { index: number; at: number } | null {
  let index = beatIndex(analysis, ms)
  if (index < 0 || analysis.beats[index]! < ms) index++
  for (; index < analysis.beats.length; index++) {
    if (!downbeat || isDownbeat(analysis, index)) return { index, at: analysis.beats[index]! }
  }
  return null
}

/** The beat period around `ms`, from the beats themselves. */
export function beatLength(analysis: Analysis, ms: number) {
  const { beats } = analysis
  const i = Math.min(Math.max(beatIndex(analysis, ms), 0), beats.length - 2)
  return i >= 0 && beats.length > 1 ? beats[i + 1]! - beats[i]! : 60000 / analysis.bpm
}

export function sectionAt(analysis: Analysis, ms: number) {
  return analysis.sections.find((section) => ms >= section.start && ms < section.end) ?? null
}

/** The first drop inside a window, or null. */
export const dropWithin = (analysis: Analysis, from: number, to: number) => analysis.drops.find((drop) => drop >= from && drop <= to) ?? null
