import { ANALYSIS_VERSION, type Analysis } from '../shared/music'

/**
 * Listen to a decoded track and find its beats, bars, sections and drops.
 *
 * The signal is mixed to mono and decimated to about 12 kHz, which keeps
 * everything that matters for rhythm. From a short-time spectrum it takes:
 * spectral flux (how much new sound starts each frame), the same for the bass
 * alone (kicks), and loudness. The tempo is the strongest lag in the flux's
 * autocorrelation, leaning toward 120 BPM; beats are then tracked through the
 * flux by dynamic programming (Ellis 2007), so a track that drifts is
 * followed. The downbeat is whichever of the four beat phases the kicks land
 * on hardest. Bars are described by loudness, bass and busyness; a section
 * boundary is where the bars before and after differ most, and a drop is a
 * boundary into a much more intense section.
 */
export function analyze(channels: Float32Array[], sampleRate: number): Analysis {
  const factor = Math.max(1, Math.round(sampleRate / 12000))
  const rate = sampleRate / factor
  const mono = downmix(channels, factor)
  const frames = spectra(mono)
  const fps = rate / HOP
  // A frame's time is the middle of its window, where an onset in it registers.
  const toMs = (frame: number) => Math.round(((frame * HOP + WIN / 2) * 1000) / rate)

  const onset = normalize(rectify(subtractMean(frames.flux, Math.round(fps * 0.25))))
  const kick = normalize(rectify(subtractMean(frames.lowFlux, Math.round(fps * 0.25))))

  const period = tempo(onset, fps)
  const beatFrames = trim(trackBeats(onset, period), frames.loud, period)
  const beats = smooth(beatFrames).map(toMs)
  const bpm = Math.round((60 * fps * 10) / period) / 10

  // The downbeat: the phase of four that the kicks hit hardest.
  const near = (signal: Float32Array, frame: number) => Math.max(signal[frame - 1] ?? 0, signal[frame]!, signal[frame + 1] ?? 0)
  const phases = [0, 0, 0, 0]
  beatFrames.forEach((frame, i) => (phases[i % 4]! += near(kick, frame) + 0.25 * near(onset, frame)))
  const downbeat = phases.indexOf(Math.max(...phases))

  const { sections, drops } = structure(frames, beatFrames, downbeat, toMs, toMs(frames.count))
  return { version: ANALYSIS_VERSION, bpm, beats, downbeat, sections, drops }
}

const WIN = 1024
const HOP = 256
/** Bins up to about 140 Hz at 12 kHz: the kick and bass. */
const BASS_BINS = 12

function downmix(channels: Float32Array[], factor: number) {
  const length = Math.floor(channels[0]!.length / factor)
  const out = new Float32Array(length)
  const scale = 1 / (factor * channels.length)
  for (const data of channels) {
    for (let i = 0; i < length; i++) {
      let sum = 0
      const from = i * factor
      for (let j = 0; j < factor; j++) sum += data[from + j]!
      out[i]! += sum * scale
    }
  }
  return out
}

interface Frames {
  count: number
  flux: Float32Array
  lowFlux: Float32Array
  /** Loudness in dB, and bass energy in dB. */
  loud: Float32Array
  bass: Float32Array
}

function spectra(signal: Float32Array): Frames {
  const count = Math.max(0, Math.floor((signal.length - WIN) / HOP))
  const flux = new Float32Array(count)
  const lowFlux = new Float32Array(count)
  const loud = new Float32Array(count)
  const bass = new Float32Array(count)
  const window = new Float32Array(WIN).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN))
  const fft = new FFT(WIN)
  const re = new Float32Array(WIN)
  const im = new Float32Array(WIN)
  let previous = new Float32Array(WIN / 2)
  let current = new Float32Array(WIN / 2)

  for (let f = 0; f < count; f++) {
    const offset = f * HOP
    let power = 0
    for (let i = 0; i < WIN; i++) {
      const x = signal[offset + i]!
      power += x * x
      re[i] = x * window[i]!
      im[i] = 0
    }
    fft.transform(re, im)
    let all = 0
    let low = 0
    let bassPower = 0
    for (let k = 1; k < WIN / 2; k++) {
      const magnitude = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!)
      current[k] = Math.log1p(magnitude)
      const rise = current[k]! - previous[k]!
      if (rise > 0) {
        all += rise
        if (k <= BASS_BINS) low += rise
      }
      if (k <= BASS_BINS) bassPower += magnitude * magnitude
    }
    flux[f] = all
    lowFlux[f] = low
    loud[f] = 10 * Math.log10(power / WIN + 1e-10)
    bass[f] = 10 * Math.log10(bassPower + 1e-10)
    ;[previous, current] = [current, previous]
  }
  return { count, flux, lowFlux, loud, bass }
}

/** In-place radix-2 FFT. */
class FFT {
  private reverse: Uint32Array
  private cos: Float32Array
  private sin: Float32Array
  constructor(private size: number) {
    const bits = Math.log2(size)
    this.reverse = new Uint32Array(size).map((_, i) => {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      return r
    })
    this.cos = new Float32Array(size / 2).map((_, i) => Math.cos((-2 * Math.PI * i) / size))
    this.sin = new Float32Array(size / 2).map((_, i) => Math.sin((-2 * Math.PI * i) / size))
  }
  transform(re: Float32Array, im: Float32Array) {
    const n = this.size
    for (let i = 0; i < n; i++) {
      const j = this.reverse[i]!
      if (j > i) {
        const r = re[i]!
        re[i] = re[j]!
        re[j] = r
        const m = im[i]!
        im[i] = im[j]!
        im[j] = m
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step]!
          const s = this.sin[k * step]!
          const a = start + k
          const b = a + half
          const tr = re[b]! * c - im[b]! * s
          const ti = re[b]! * s + im[b]! * c
          re[b] = re[a]! - tr
          im[b] = im[a]! - ti
          re[a]! += tr
          im[a]! += ti
        }
      }
    }
  }
}

function subtractMean(signal: Float32Array, radius: number) {
  const out = new Float32Array(signal.length)
  let sum = 0
  let lo = 0
  let hi = 0
  for (let i = 0; i < signal.length; i++) {
    while (hi < Math.min(signal.length, i + radius + 1)) sum += signal[hi++]!
    while (lo < i - radius) sum -= signal[lo++]!
    out[i] = signal[i]! - sum / (hi - lo)
  }
  return out
}

const rectify = (signal: Float32Array) => signal.map((x) => Math.max(0, x))

function normalize(signal: Float32Array) {
  let sum = 0
  let squares = 0
  for (const x of signal) {
    sum += x
    squares += x * x
  }
  const mean = sum / Math.max(1, signal.length)
  const std = Math.sqrt(Math.max(1e-12, squares / Math.max(1, signal.length) - mean * mean))
  return signal.map((x) => x / std)
}

/**
 * The beat period in frames: the autocorrelation peak, weighted toward 120
 * BPM. Each candidate also counts the correlation two and four beats on (half
 * a bar and a bar, in four-four), which tells the real beat from a reading
 * of it in threes that the correlation alone can prefer.
 */
function tempo(onset: Float32Array, fps: number) {
  const minLag = Math.floor((60 * fps) / 200)
  const maxLag = Math.ceil((60 * fps) / 60)
  const scores = new Float32Array(4 * maxLag + 2)
  for (let lag = minLag; lag <= 4 * maxLag + 1; lag++) {
    let sum = 0
    for (let i = 0; i + lag < onset.length; i++) sum += onset[i]! * onset[i + lag]!
    scores[lag] = sum / (onset.length - lag)
  }
  let best = minLag
  let bestWeighted = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag
    const metre = scores[lag]! + 0.5 * scores[2 * lag]! + 0.5 * scores[4 * lag]!
    const weighted = metre * Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
    if (weighted > bestWeighted) {
      bestWeighted = weighted
      best = lag
    }
  }
  // Refine between frames with a parabola through the peak.
  const [a, b, c] = [scores[best - 1]!, scores[best]!, scores[best + 1]!]
  const denominator = a - 2 * b + c
  let period = best + (denominator < 0 ? (0.5 * (a - c)) / denominator : 0)
  // Keep to a range people count along to.
  while ((60 * fps) / period < 80) period /= 2
  while ((60 * fps) / period > 170) period *= 2
  return period
}

/** Drop beats carried into silence before the music starts or after it ends. */
function trim(beats: number[], loud: Float32Array, period: number) {
  const sorted = [...loud].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.9)]! - 45
  const audible = (frame: number) => {
    let peak = -Infinity
    for (let f = Math.max(0, Math.floor(frame - period / 2)); f < Math.min(loud.length, frame + period / 2); f++) peak = Math.max(peak, loud[f]!)
    return peak > floor
  }
  let from = 0
  let to = beats.length
  while (from < to && !audible(beats[from]!)) from++
  while (to > from && !audible(beats[to - 1]!)) to--
  return beats.slice(from, to)
}

/**
 * Beats come out on whole frames, about 21 ms apart. A straight line through
 * each beat's neighbours places it between frames, which is what ears notice.
 */
function smooth(beats: number[], radius = 4) {
  return beats.map((_, i) => {
    const from = Math.max(0, i - radius)
    const to = Math.min(beats.length - 1, i + radius)
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    const n = to - from + 1
    for (let j = from; j <= to; j++) {
      sx += j
      sy += beats[j]!
      sxx += j * j
      sxy += j * beats[j]!
    }
    const slope = n > 1 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0
    return (sy - slope * sx) / n + slope * i
  })
}

/** Ellis-style dynamic programming: beats that land on onsets and keep the period. */
function trackBeats(onset: Float32Array, period: number) {
  const n = onset.length
  const score = new Float32Array(n)
  const back = new Int32Array(n).fill(-1)
  const tightness = 1000
  for (let t = 0; t < n; t++) {
    let best = 0
    let from = -1
    const lo = Math.max(0, Math.floor(t - 2 * period))
    const hi = Math.floor(t - period / 2)
    for (let p = lo; p <= hi; p++) {
      const candidate = score[p]! - tightness * Math.log((t - p) / period) ** 2
      if (candidate > best || from < 0) {
        best = candidate
        from = p
      }
    }
    score[t] = onset[t]! + (from >= 0 ? best : 0)
    back[t] = from
  }
  // End on the best-scoring frame within the last period, then walk back.
  let end = n - 1
  for (let t = Math.max(0, Math.floor(n - period)); t < n; t++) if (score[t]! > score[end]!) end = t
  const beats: number[] = []
  for (let t = end; t >= 0; t = back[t]!) beats.push(t)
  return beats.reverse()
}

function structure(frames: Frames, beats: number[], downbeat: number, toMs: (frame: number) => number, endMs: number) {
  // Bars, and what each sounds like.
  const bars: { start: number; end: number; features: number[] }[] = []
  for (let i = downbeat; i + 4 < beats.length; i += 4) {
    const [from, to] = [beats[i]!, beats[i + 4]!]
    let loud = 0
    let bass = 0
    let busy = 0
    for (let f = from; f < to; f++) {
      loud += frames.loud[f]!
      bass += frames.bass[f]!
      busy += frames.flux[f]!
    }
    const length = Math.max(1, to - from)
    bars.push({ start: from, end: to, features: [loud / length, bass / length, busy / length] })
  }
  if (bars.length < 8) return { sections: [{ start: 0, end: endMs, energy: 0.5 }], drops: [] }

  // Standardise each feature across the track.
  const dims = bars[0]!.features.length
  for (let d = 0; d < dims; d++) {
    const values = bars.map((bar) => bar.features[d]!)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 1
    bars.forEach((bar) => (bar.features[d] = (bar.features[d]! - mean) / std))
  }

  // Novelty at each bar line: how different the four bars after are from the four before.
  const W = 4
  const novelty = bars.map((_, b) => {
    if (b < 2 || b > bars.length - 2) return 0
    const mean = (from: number, to: number) => {
      const slice = bars.slice(Math.max(0, from), Math.min(bars.length, to))
      return Array.from({ length: dims }, (_, d) => slice.reduce((a, bar) => a + bar.features[d]!, 0) / slice.length)
    }
    const [before, after] = [mean(b - W, b), mean(b, b + W)]
    return Math.sqrt(before.reduce((a, x, d) => a + (x - after[d]!) ** 2, 0))
  })
  const average = novelty.reduce((a, b) => a + b, 0) / novelty.length
  const boundaries: number[] = []
  for (let b = 2; b < bars.length - 1; b++) {
    const local = novelty.slice(Math.max(0, b - 4), b + 5)
    if (novelty[b]! >= Math.max(...local) && novelty[b]! > average * 1.3 && (boundaries.length === 0 || b - boundaries.at(-1)! >= 8)) boundaries.push(b)
  }

  // How intense each bar is, scaled between the track's quiet and loud bars
  // (percentiles, so a fade-out at the end doesn't squash everything else).
  const intensity = bars.map((bar) => bar.features[0]! + bar.features[1]! + 0.5 * bar.features[2]!)
  const ranked = [...intensity].sort((x, y) => x - y)
  const pick = (q: number) => ranked[Math.floor(q * (ranked.length - 1))]!
  const [lo, hi] = [pick(0.1), pick(0.95)]
  const scaled = intensity.map((value) => Math.min(1, Math.max(0, (value - lo) / Math.max(1e-6, hi - lo))))
  const mean = (from: number, to: number) => {
    const slice = scaled.slice(Math.max(0, from), Math.min(scaled.length, to))
    return slice.length ? slice.reduce((x, y) => x + y, 0) / slice.length : 0
  }

  const edges = [0, ...boundaries, bars.length]
  const sections = edges.slice(0, -1).map((from, i) => ({
    start: i === 0 ? 0 : toMs(bars[from]!.start),
    end: i === edges.length - 2 ? endMs : toMs(bars[edges[i + 1]!]!.start),
    energy: Math.round(mean(from, edges[i + 1]!) * 100) / 100,
  }))

  // A drop: the next two bars jump well above the four before, into one of
  // the track's more intense stretches. Kept eight bars apart.
  const candidates = bars
    .map((_, b) => ({ b, jump: mean(b, b + 2) - mean(b - 4, b), after: mean(b, b + 4) }))
    .filter(({ b, jump, after }) => b >= 4 && jump >= 0.35 && after >= 0.6)
    .sort((x, y) => y.jump - x.jump)
  const chosen: number[] = []
  for (const { b } of candidates) if (chosen.every((c) => Math.abs(c - b) >= 8)) chosen.push(b)
  const drops = chosen.sort((x, y) => x - y).map((b) => toMs(bars[b]!.start))
  return { sections, drops }
}
