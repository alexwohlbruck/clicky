import type { Team, Track } from '../shared/protocol'
import playlist from '../shared/tracks.json'

/**
 * Music, voice lines and press sounds through one Web Audio graph. Browsers
 * only allow it to start inside a user gesture, so `unlock` is called from one.
 */
export class Sound {
  readonly music = new Audio()
  private context: AudioContext | null = null
  private master!: GainNode
  /** Everything musical goes through here, so the analyser hears it. */
  private musicBus!: GainNode
  /** Fetched at load so the intro can start the moment it's allowed to. */
  private introBytes = fetch('/audio/game-music.mp3').then((response) => response.arrayBuffer())
  private introBuffer: Promise<AudioBuffer> | null = null
  private intro: AudioBufferSourceNode | null = null
  private analyser!: AnalyserNode
  private spectrum = new Uint8Array(0)
  private voices = new Map<string, AudioBuffer>()
  private noise!: AudioBuffer
  private smoothedBeat = 0

  /** Called when the playing song changes, so the page can show it. */
  onTrack: (track: Track) => void = () => {}

  /** A room's track waiting for the intro song to stop. */
  private pending: { track: Track; elapsedMs: number; at: number } | null = null
  /** Once a room is choosing the music, the shuffle stops. */
  private inRoom = false

  constructor() {
    this.music.crossOrigin = 'anonymous'
    this.music.preload = 'auto'
    // Before joining a room there's no queue to follow, so shuffle the playlist.
    this.music.addEventListener('ended', () => {
      if (!this.inRoom) this.shuffle()
    })
  }

  get muted() {
    return localStorage.getItem('clicky-muted') === '1'
  }

  set muted(muted: boolean) {
    localStorage.setItem('clicky-muted', muted ? '1' : '0')
    if (this.master) this.master.gain.value = muted ? 0 : 1
  }

  unlock() {
    if (this.context) {
      void this.context.resume()
      return
    }
    const context = new AudioContext()
    this.context = context
    this.master = context.createGain()
    this.master.gain.value = this.muted ? 0 : 1
    this.master.connect(context.destination)

    this.analyser = context.createAnalyser()
    this.analyser.fftSize = 512
    this.analyser.smoothingTimeConstant = 0.6
    this.spectrum = new Uint8Array(this.analyser.frequencyBinCount)
    this.musicBus = context.createGain()
    this.musicBus.connect(this.analyser)
    this.analyser.connect(this.master)
    context.createMediaElementSource(this.music).connect(this.musicBus)
    this.introBuffer = this.introBytes.then((bytes) => context.decodeAudioData(bytes))

    this.noise = context.createBuffer(1, context.sampleRate * 0.25, context.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

    for (const name of ['thats_unfortunate', 'how_unfortunate']) {
      fetch(`/audio/${name}.wav`)
        .then((response) => response.arrayBuffer())
        .then((bytes) => context.decodeAudioData(bytes))
        .then((buffer) => this.voices.set(name, buffer))
        .catch(() => {})
    }
  }

  /**
   * Start the intro music and return a clock for the visuals: milliseconds
   * into the song, as of the frame being drawn reaching the screen. It reads
   * the audio hardware's own timestamp, so speaker latency is accounted for.
   * The `<audio>` element's currentTime only moves every 20-50 ms, too
   * coarse for a strobe timed to the note.
   */
  async playIntro(): Promise<() => number> {
    const context = this.context!
    const buffer = await this.introBuffer!
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.musicBus)
    source.onended = () => this.introEnded(source)
    const startAt = context.currentTime + 0.05
    source.start(startAt)
    this.intro = source
    this.introPlaying = true

    // One frame ahead: what's drawn now is seen at the next refresh.
    const FRAME_MS = 16
    return () => {
      const stamp = context.getOutputTimestamp?.()
      if (stamp?.contextTime && stamp.performanceTime) {
        const heard = stamp.contextTime + (performance.now() + FRAME_MS - stamp.performanceTime) / 1000
        return (heard - startAt) * 1000
      }
      const latency = context.outputLatency || context.baseLatency || 0
      return (context.currentTime - latency - startAt) * 1000 + FRAME_MS
    }
  }

  private introPlaying = false

  /** The intro song plays once, then hands over to the room or the shuffle. */
  private introEnded(source: AudioBufferSourceNode) {
    if (source !== this.intro) return
    source.disconnect()
    this.intro = null
    this.introPlaying = false

    const pending = this.pending
    this.pending = null
    if (pending) this.stream(pending.track, pending.elapsedMs + performance.now() - pending.at)
    else this.shuffle()
  }

  private shuffle() {
    const tracks = playlist as Track[]
    const track = tracks[Math.floor(Math.random() * tracks.length)]!
    this.stream(track, 0)
  }

  /**
   * Follow the room's track, joining where the room is up to. Joining a game
   * cuts the intro song short; its `onended` then starts this track.
   */
  playTrack(track: Track, elapsedMs: number) {
    this.inRoom = true
    if (this.introPlaying) {
      this.pending = { track, elapsedMs, at: performance.now() }
      this.intro?.stop()
      return
    }
    this.stream(track, elapsedMs)
  }

  private stream(track: Track, elapsedMs: number) {
    this.onTrack(track)
    const url = new URL(`/music/${track.id}`, location.href)
    url.searchParams.set('startMs', String(Math.max(0, Math.round(elapsedMs))))
    url.searchParams.set('requestedAtMs', String(Date.now()))
    this.music.loop = false
    this.music.src = url.href
    void this.music.play().catch(() => {})
  }

  /** Bass energy of the music, 0 to 1, for the visuals to pulse with. */
  beat() {
    if (!this.analyser || (this.music.paused && !this.introPlaying)) return (this.smoothedBeat *= 0.9)
    this.analyser.getByteFrequencyData(this.spectrum)
    let sum = 0
    for (let i = 1; i < 8; i++) sum += this.spectrum[i]!
    const level = Math.max(0, sum / 7 / 255 - 0.45) / 0.55
    this.smoothedBeat = Math.max(level, this.smoothedBeat * 0.85)
    return this.smoothedBeat
  }

  /** A click for a press. Creators chirp upward with the bar; destroyers crunch. */
  press(team: Team, progress: number, loud: boolean) {
    const context = this.context
    if (!context) return
    const now = context.currentTime
    const gain = context.createGain()
    gain.connect(this.master)
    const level = loud ? 0.22 : 0.06

    if (team === 'creators') {
      const osc = context.createOscillator()
      osc.type = 'square'
      const pitch = 300 + progress * 700
      osc.frequency.setValueAtTime(pitch, now)
      osc.frequency.exponentialRampToValueAtTime(pitch * 1.9, now + 0.05)
      gain.gain.setValueAtTime(level * 0.5, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08)
      osc.connect(gain)
      osc.start(now)
      osc.stop(now + 0.09)
    } else {
      const source = context.createBufferSource()
      source.buffer = this.noise
      const filter = context.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 500 + (1 - progress) * 1500
      filter.Q.value = 1.4
      gain.gain.setValueAtTime(level * 1.6, now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1)
      source.connect(filter).connect(gain)
      source.start(now, Math.random() * 0.1, 0.11)
    }
  }

  /** A short square-wave note, for the countdown and pickups. */
  blip(frequency: number, duration = 0.12, delay = 0, level = 0.12) {
    const context = this.context
    if (!context) return
    const at = context.currentTime + delay
    const osc = context.createOscillator()
    const gain = context.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(frequency, at)
    gain.gain.setValueAtTime(level, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    osc.connect(gain).connect(this.master)
    osc.start(at)
    osc.stop(at + duration + 0.02)
  }

  /** The surge pickup: a two-note coin. */
  coin() {
    this.blip(988, 0.08)
    this.blip(1319, 0.3, 0.08)
  }

  /** One oscillator note with a pitch glide and a quick decay. */
  private tone(type: OscillatorType, from: number, to: number, delay: number, duration: number, level: number) {
    const context = this.context
    if (!context) return
    const at = context.currentTime + delay
    const osc = context.createOscillator()
    const gain = context.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(from, at)
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + duration)
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.linearRampToValueAtTime(level, at + Math.min(0.01, duration / 4))
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    osc.connect(gain).connect(this.master)
    osc.start(at)
    osc.stop(at + duration + 0.02)
  }

  /** Filtered noise, swept from one frequency to another. */
  private whoosh(from: number, to: number, duration: number, level: number, delay = 0) {
    const context = this.context
    if (!context) return
    const at = context.currentTime + delay
    const source = context.createBufferSource()
    source.buffer = this.noise
    source.loop = true
    const filter = context.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.value = 3
    filter.frequency.setValueAtTime(from, at)
    filter.frequency.exponentialRampToValueAtTime(to, at + duration)
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.linearRampToValueAtTime(level, at + duration * 0.7)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    source.connect(filter).connect(gain).connect(this.master)
    source.start(at)
    source.stop(at + duration + 0.02)
  }

  /** The countdown: three ticks climbing toward the start. */
  countdownTick(step: number, delay: number) {
    this.tone('square', 440 + step * 110, 440 + step * 110, delay, 0.14, 0.11)
    this.tone('sine', 110, 55, delay, 0.18, 0.25)
  }

  /** The round starts: a bright chord over a kick. */
  go() {
    for (const ratio of [1, 1.25, 1.5]) this.tone('square', 880 * ratio, 880 * ratio, 0, 0.35, 0.05)
    this.tone('sine', 160, 40, 0, 0.3, 0.5)
  }

  /** Every tenth press in a streak: an arpeggio that climbs with the streak. */
  combo(level: number) {
    const base = 523 * 2 ** (Math.min(level - 1, 8) / 12)
    ;[1, 1.26, 1.5, 2].forEach((ratio, i) => this.tone('square', base * ratio, base * ratio, i * 0.035, 0.09, 0.07))
  }

  /** Crossing ten presses a second. */
  onFire() {
    this.whoosh(300, 4000, 0.45, 0.35)
    this.tone('sawtooth', 220, 880, 0.05, 0.4, 0.05)
  }

  /** Your side is about to lose: a low double thump, louder the closer it is. */
  heartbeat(danger: number) {
    const level = 0.25 + danger * 0.35
    this.tone('sine', 90, 45, 0, 0.16, level)
    this.tone('sine', 80, 40, 0.14, 0.14, level * 0.7)
  }

  /** Double time: a rising sweep, then a stab. */
  frenzy() {
    this.whoosh(200, 6000, 0.7, 0.4)
    for (const ratio of [1, 1.5, 2]) this.tone('sawtooth', 330 * ratio, 330 * ratio, 0.65, 0.4, 0.05)
  }

  /** A surge orb appears on the bar. */
  shimmer() {
    ;[1568, 2093, 2637, 3136].forEach((f, i) => this.tone('sine', f, f, i * 0.05, 0.25, 0.05))
  }

  /** Someone reacts. */
  pop() {
    this.tone('sine', 600 + Math.random() * 300, 1400, 0, 0.07, 0.12)
  }

  /** A chat message arrives. */
  chatTick() {
    this.tone('triangle', 1760, 1760, 0, 0.06, 0.08)
    this.tone('triangle', 2349, 2349, 0.05, 0.08, 0.06)
  }

  /** Someone joins (up) or leaves (down) the lobby. */
  roster(joined: boolean) {
    const [a, b] = joined ? [659, 988] : [988, 659]
    this.tone('triangle', a, a, 0, 0.09, 0.09)
    this.tone('triangle', b, b, 0.08, 0.12, 0.09)
  }

  /** A soft tick for buttons. */
  click() {
    this.tone('triangle', 1200, 900, 0, 0.03, 0.05)
  }

  /** The original's Tong voice for a loss, and a rising stab for a win. */
  roundOver(won: boolean) {
    const context = this.context
    if (!context) return

    if (!won) {
      const names = [...this.voices.keys()]
      const buffer = this.voices.get(names[Math.floor(Math.random() * names.length)]!)
      if (!buffer) return
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(this.master)
      source.start()
      return
    }

    const now = context.currentTime
    this.whoosh(400, 5000, 0.5, 0.25)
    for (const [i, ratio] of [1, 1.25, 1.5, 2].entries()) {
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(220 * ratio, now + i * 0.06)
      osc.frequency.exponentialRampToValueAtTime(440 * ratio, now + 0.5)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.linearRampToValueAtTime(0.06, now + i * 0.06 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9)
      osc.connect(gain).connect(this.master)
      osc.start(now + i * 0.06)
      osc.stop(now + 1)
    }
  }
}
