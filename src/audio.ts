import type { Team, Track } from '../shared/protocol'

/**
 * Music, voice lines and press sounds through one Web Audio graph. Browsers
 * only allow it to start inside a user gesture, so `unlock` is called from one.
 */
export class Sound {
  readonly music = new Audio()
  private context: AudioContext | null = null
  private master!: GainNode
  private analyser!: AnalyserNode
  private spectrum = new Uint8Array(0)
  private voices = new Map<string, AudioBuffer>()
  private noise!: AudioBuffer
  private smoothedBeat = 0

  constructor() {
    this.music.crossOrigin = 'anonymous'
    this.music.preload = 'auto'
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
    context.createMediaElementSource(this.music).connect(this.analyser)
    this.analyser.connect(this.master)

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

  playIntro() {
    this.music.loop = false
    this.music.src = '/audio/game-music.mp3'
    return this.music.play()
  }

  /** Join the room's track where the room is up to. */
  playTrack(track: Track, elapsedMs: number) {
    const url = new URL(`/music/${track.id}`, location.href)
    url.searchParams.set('startMs', String(Math.max(0, Math.round(elapsedMs))))
    url.searchParams.set('requestedAtMs', String(Date.now()))
    this.music.loop = false
    this.music.src = url.href
    void this.music.play().catch(() => {})
  }

  /** Bass energy of the music, 0 to 1, for the visuals to pulse with. */
  beat() {
    if (!this.analyser || this.music.paused) return (this.smoothedBeat *= 0.9)
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
