import type { Team, Track } from '../shared/protocol'
import playlist from '../shared/tracks.json'
import { beatIndex, beatLength, isDownbeat, sectionAt, type Analysis } from '../shared/music'

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

  /** The room's song goes through a gate and a low-pass, so play can cut it, muffle it and open it up. */
  private songGate!: GainNode
  private songFilter!: BiquadFilterNode

  /** The current song's analysis, once the server has it. */
  analysis: Analysis | null = null
  /** Where the playing file or stream starts in the song (ms). */
  private streamStart = 0
  private streamStartGuessed = false
  private lastBeatIndex = -1
  private lastMusicMs = -1
  private loadedAt = 0
  private lastSyncAt = 0
  /** In a room: when the room's song started, on this page's clock, so ours can follow it. */
  private roomAnchor: number | null = null

  /** Called on each beat of the song, and on each drop. */
  onBeat: (index: number, downbeat: boolean) => void = () => {}
  onDrop: () => void = () => {}

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
    // A limiter at the end, so stacked hits get loud without distorting.
    const limiter = context.createDynamicsCompressor()
    limiter.threshold.value = -6
    limiter.knee.value = 4
    limiter.ratio.value = 16
    limiter.attack.value = 0.002
    limiter.release.value = 0.2
    this.master.connect(limiter).connect(context.destination)

    this.analyser = context.createAnalyser()
    this.analyser.fftSize = 512
    this.analyser.smoothingTimeConstant = 0.6
    this.spectrum = new Uint8Array(this.analyser.frequencyBinCount)
    this.musicBus = context.createGain()
    this.musicBus.connect(this.analyser)
    this.analyser.connect(this.master)
    const song = context.createMediaElementSource(this.music)
    this.songGate = context.createGain()
    this.songFilter = context.createBiquadFilter()
    this.songFilter.type = 'lowpass'
    this.songFilter.frequency.value = 20000
    song.connect(this.songGate).connect(this.songFilter).connect(this.musicBus)

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
    this.roomAnchor = performance.now() - elapsedMs
    if (this.introPlaying) {
      this.pending = { track, elapsedMs, at: performance.now() }
      this.intro?.stop()
      return
    }
    this.stream(track, elapsedMs)
  }

  /**
   * Play a song from `elapsedMs` in. The server keeps a copy of every song it
   * has analysed, which starts at once and seeks exactly, so that's used when
   * there is one. Otherwise Jukebox streams it live (seconds to start, and no
   * seeking), and the kept copy takes over as soon as the server has it.
   */
  /** A better reading of the room's position in its song; \`follow\` closes the gap. */
  retime(elapsedMs: number) {
    if (!this.inRoom) return
    this.roomAnchor = performance.now() - elapsedMs
    this.lastSyncAt = 0
  }

  private stream(track: Track, elapsedMs: number) {
    this.onTrack(track)
    this.analysis = null
    this.kept = false
    this.lastSyncAt = 0
    this.lastBeatIndex = -1
    this.lastMusicMs = -1
    this.streamStartGuessed = false
    if (!this.inRoom) this.roomAnchor = null
    const token = ++this.streamToken
    const askedAt = performance.now()
    // Where the song should be by the time it can play.
    const position = () => (this.roomAnchor !== null ? performance.now() - this.roomAnchor : elapsedMs + performance.now() - askedAt)

    void (async () => {
      let analysis = await this.fetchAnalysis(track.id, 1500)
      if (token !== this.streamToken) return
      if (analysis) return this.playKept(track.id, analysis, position)

      // Jukebox starts the stream where it was asked to (plus 20 ms of encoder
      // priming, measured), however long the request takes.
      const url = new URL(`/music/${track.id}`, location.href)
      url.searchParams.set('startMs', String(Math.max(0, Math.round(elapsedMs))))
      url.searchParams.set('requestedAtMs', String(Date.now()))
      this.streamStart = Math.max(0, elapsedMs) + 20
      this.music.loop = false
      this.music.src = url.href
      this.music.addEventListener('loadeddata', () => (this.streamStartGuessed = true), { once: true })
      void this.music.play().catch(() => {})

      // Keep asking; the server works on a song as soon as someone plays it.
      for (let attempt = 0; attempt < 12 && !analysis; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        if (token !== this.streamToken) return
        analysis = await this.fetchAnalysis(track.id, 20000)
      }
      if (analysis && token === this.streamToken) {
        // Without a room to follow, carry on from where the stream had got to.
        const from = this.musicMs() ?? elapsedMs + performance.now() - askedAt
        const at = performance.now()
        this.playKept(track.id, analysis, this.roomAnchor !== null ? position : () => from + performance.now() - at)
      }
    })()
  }

  private kept = false
  private streamToken = 0

  private playKept(id: string, analysis: Analysis, position: () => number) {
    this.analysis = analysis
    this.kept = true
    this.streamStart = 0
    this.lastBeatIndex = -1
    this.lastMusicMs = -1
    this.music.loop = false
    this.music.src = `/music/${id}/file`
    this.music.addEventListener(
      'loadedmetadata',
      () => {
        this.music.currentTime = Math.max(0, position() / 1000)
        this.streamStartGuessed = true
        this.loadedAt = performance.now()
        void this.music.play().catch(() => {})
      },
      { once: true },
    )
  }

  private async fetchAnalysis(id: string, timeout: number) {
    try {
      const response = await fetch(`/api/analysis/${id}`, { signal: AbortSignal.timeout(timeout) })
      return response.ok ? ((await response.json()) as Analysis) : null
    } catch {
      return null
    }
  }

  /** Milliseconds into the room's song, as heard, or null if it isn't playing. */
  musicMs() {
    if (!this.context || this.music.paused || !this.streamStartGuessed) return null
    const latency = (this.context.outputLatency || this.context.baseLatency || 0) * 1000
    return this.streamStart + this.music.currentTime * 1000 - latency
  }

  /** How intense this part of the song is, 0 to 1 (0.5 if unknown). */
  energy() {
    const ms = this.musicMs()
    return this.analysis && ms !== null ? (sectionAt(this.analysis, ms)?.energy ?? 0.5) : 0.5
  }

  /**
   * Once a frame: keep to the room's timeline, fire beat and
   * drop callbacks, and return how hard to pulse the visuals, 0 to 1.
   */
  beat() {
    const ms = this.musicMs()
    const analysis = this.analysis
    if (!analysis || ms === null) return this.reactiveBeat()

    this.follow(ms)
    const index = beatIndex(analysis, ms)
    if (index !== this.lastBeatIndex && index >= 0 && this.lastBeatIndex >= 0 && index === this.lastBeatIndex + 1) this.onBeat(index, isDownbeat(analysis, index))
    if (this.lastMusicMs >= 0 && ms > this.lastMusicMs && ms - this.lastMusicMs < 500) {
      if (analysis.drops.some((drop) => drop > this.lastMusicMs && drop <= ms)) this.onDrop()
    }
    this.lastBeatIndex = index
    this.lastMusicMs = ms
    if (index < 0) return 0

    // A sharp pulse on every beat, harder on the downbeat, scaled by the section.
    const since = ms - analysis.beats[index]!
    const strength = isDownbeat(analysis, index) ? 1 : 0.6
    return Math.exp(-since / 110) * strength * (0.45 + 0.55 * this.energy())
  }

  /**
   * Keep to the room's timeline. The stream arrives a few seconds behind it
   * (the song has to be found, cut, encoded, sent and buffered), by a
   * different amount for each player, so moments the server times to the music
   * would miss the beat. The server's own copy of a song seeks anywhere, so
   * skip by the difference; a live stream only within what it has buffered.
   * Checked again every few seconds.
   */
  private follow(ms: number) {
    const now = performance.now()
    if (this.roomAnchor === null || !this.kept || now - this.loadedAt < 1500 || now - this.lastSyncAt < 3000) return
    this.lastSyncAt = now
    const drift = now - this.roomAnchor - ms
    if (Math.abs(drift) < 40) return
    const target = this.music.currentTime + drift / 1000
    const { buffered } = this.music
    // The kept file seeks anywhere; a live stream only within what's buffered.
    const seekable = this.kept || Array.from({ length: buffered.length }, (_, i) => [buffered.start(i), buffered.end(i) - 0.5]).some(([lo, hi]) => target >= lo! && target <= hi!)
    if (!seekable || target < 0) return
    this.music.currentTime = target
    this.lastBeatIndex = -1
    this.lastMusicMs = -1
  }

  /** Without an analysis: bass energy of the music, 0 to 1. */
  private reactiveBeat() {
    if (!this.analyser || (this.music.paused && !this.introPlaying)) return (this.smoothedBeat *= 0.9)
    this.analyser.getByteFrequencyData(this.spectrum)
    let sum = 0
    for (let i = 1; i < 8; i++) sum += this.spectrum[i]!
    const level = Math.max(0, sum / 7 / 255 - 0.45) / 0.55
    this.smoothedBeat = Math.max(level, this.smoothedBeat * 0.85)
    return this.smoothedBeat
  }

  /** Seconds from now until a point in the song, or null if that can't be known. */
  untilMusic(ms: number) {
    const now = this.musicMs()
    return now === null ? null : (ms - now) / 1000
  }

  /** Cut the song dead, as a round ends. */
  cutSong() {
    if (!this.songGate) return
    const at = this.context!.currentTime
    this.songGate.gain.cancelScheduledValues(at)
    this.songGate.gain.setTargetAtTime(0, at, 0.008)
  }

  /** Bring the song back in, muffled, `delay` seconds from now, while waiting to play. */
  muffleSong(delay = 0, seconds = 0.6) {
    if (!this.songGate) return
    const at = this.context!.currentTime + Math.max(0, delay)
    this.songGate.gain.cancelScheduledValues(at)
    this.songGate.gain.setTargetAtTime(0.6, at, seconds / 3)
    this.songFilter.frequency.cancelScheduledValues(at)
    this.songFilter.frequency.setTargetAtTime(450, at, seconds / 4)
  }

  /** Open the song up fully, `delay` seconds from now: the moment play starts. */
  openSong(delay = 0) {
    if (!this.songGate) return
    const at = this.context!.currentTime + Math.max(0, delay)
    this.songGate.gain.cancelScheduledValues(at)
    this.songGate.gain.setTargetAtTime(1, at, 0.01)
    this.songFilter.frequency.cancelScheduledValues(at)
    this.songFilter.frequency.setValueAtTime(this.songFilter.frequency.value, at)
    this.songFilter.frequency.exponentialRampToValueAtTime(20000, at + 0.08)
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

  /** The round starts: a bright chord over a kick, `delay` seconds from now. */
  go(delay = 0) {
    for (const ratio of [1, 1.25, 1.5]) this.tone('square', 880 * ratio, 880 * ratio, delay, 0.35, 0.05)
    this.tone('sine', 160, 40, delay, 0.3, 0.5)
    this.whoosh(300, 6000, 0.35, 0.3, Math.max(0, delay - 0.35))
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

  /** The original's Tong voice, for the side that lost a round. */
  private tong(delay: number) {
    const context = this.context
    const names = [...this.voices.keys()]
    const buffer = this.voices.get(names[Math.floor(Math.random() * names.length)]!)
    if (!context || !buffer) return
    const source = context.createBufferSource()
    source.buffer = buffer
    // A touch louder than the score so it reads over it.
    const gain = context.createGain()
    gain.gain.value = 1.3
    source.connect(gain).connect(this.master)
    source.start(context.currentTime + delay)
  }

  /** A soft-clipping stage for the stabs, built once. */
  private drive: WaveShaperNode | null = null
  private driven() {
    if (!this.drive) {
      const curve = new Float32Array(1024)
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1
        curve[i] = Math.tanh(x * 4)
      }
      this.drive = this.context!.createWaveShaper()
      this.drive.curve = curve
      const trim = this.context!.createGain()
      trim.gain.value = 0.35
      this.drive.connect(trim).connect(this.master)
    }
    return this.drive
  }

  /** A burst of filtered noise with an instant attack. */
  private crash(delay: number, duration: number, level: number, cutoff: number) {
    const context = this.context!
    const at = context.currentTime + delay
    const source = context.createBufferSource()
    source.buffer = this.noise
    source.loop = true
    const filter = context.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = cutoff
    const gain = context.createGain()
    gain.gain.setValueAtTime(level, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    source.connect(filter).connect(gain).connect(this.master)
    source.start(at)
    source.stop(at + duration + 0.02)
  }

  /** A chord of saws through the drive. */
  private stab(delay: number, root: number, ratios: number[], duration: number, level: number) {
    const context = this.context!
    const at = context.currentTime + delay
    for (const ratio of ratios) {
      for (const detune of [-8, 8]) {
        const osc = context.createOscillator()
        const gain = context.createGain()
        osc.type = 'sawtooth'
        osc.frequency.value = root * ratio
        osc.detune.value = detune
        gain.gain.setValueAtTime(level, at)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
        osc.connect(gain).connect(this.driven())
        osc.start(at)
        osc.stop(at + duration + 0.02)
      }
    }
  }

  /** The hit that opens a sequence: a sub drop, a crash and a driven chord. */
  private impact(delay: number, chord: number[], big: boolean) {
    this.tone('sine', 160, 30, delay, big ? 1.4 : 0.9, 0.65)
    this.tone('triangle', 90, 40, delay, 0.25, 0.45)
    this.crash(delay, big ? 1.6 : 1, 0.45, 3000)
    this.stab(delay, 110, chord, big ? 1.4 : 0.9, 0.5)
  }

  /**
   * The strobe as sound: noise and a low buzz gated on every flip, louder as
   * it goes. Slow strobes get a kick on each flip instead of a buzz.
   */
  private stutter(from: number, to: number, period: number, level: number, pitch: number) {
    const context = this.context!
    const start = context.currentTime + from
    const length = to - from
    const gate = context.createGain()
    gate.gain.setValueAtTime(0, start)
    gate.connect(this.master)

    const noise = context.createBufferSource()
    noise.buffer = this.noise
    noise.loop = true
    const filter = context.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.value = 0.8
    filter.frequency.setValueAtTime(1200, start)
    filter.frequency.exponentialRampToValueAtTime(5000, start + length)
    noise.connect(filter).connect(gate)
    noise.start(start)
    noise.stop(start + length + 0.05)

    const buzz = context.createOscillator()
    buzz.type = 'square'
    buzz.frequency.value = pitch
    const buzzLevel = context.createGain()
    buzzLevel.gain.value = 0.35
    buzz.connect(buzzLevel).connect(gate)
    buzz.start(start)
    buzz.stop(start + length + 0.05)

    const step = period / 1000
    const flips = Math.ceil(length / step)
    for (let i = 0; i < flips; i++) {
      const at = start + i * step
      const swell = level * (0.45 + 0.55 * (i / Math.max(1, flips - 1)))
      gate.gain.setValueAtTime(swell, at)
      gate.gain.setValueAtTime(0, at + Math.min(step * 0.55, 0.06))
      if (period >= 120) this.tone('sine', 130, 38, from + i * step, 0.14, 0.8)
    }
  }

  /**
   * The score for a round or game ending, laid on the same timeline as its
   * flash: an impact, the strobe as a gated buzz, a note per letter climbing
   * for a win and falling for a loss, a riser into each faster strobe, and a
   * last hit. Times are ms into the sequence.
   */
  score(cues: { strobes: { from: number; to: number; period: number }[]; letters: number[]; end: number }, mood: 'won' | 'lost' | 'neutral', gameOver: boolean) {
    const context = this.context
    if (!context) return
    // Scheduled ahead of output latency so it's heard as the frame is seen.
    const lead = context.outputLatency || context.baseLatency || 0
    const at = (ms: number) => Math.max(0, ms / 1000 - lead)
    const lost = mood === 'lost'
    const major = [1, 1.26, 1.5, 2]
    const diminished = [1, 1.19, 1.41, 1.68]

    this.impact(0, lost ? diminished : major, gameOver)
    if (lost) this.tong(0.35)

    for (const [i, strobe] of cues.strobes.entries()) {
      // Under the voice, the strobe backs off so it can be heard.
      const level = (strobe.period < 60 ? 0.45 : strobe.period < 120 ? 0.36 : 0.25) * (lost && i === 0 ? 0.6 : 1)
      this.stutter(at(strobe.from), at(strobe.to), strobe.period, level, lost ? 55 : 82)
      if (i > 0) {
        // A riser into a strobe change, and a drop when it lands.
        this.whoosh(300, 7000, 0.6, 0.35, Math.max(0, at(strobe.from) - 0.6))
        this.impact(at(strobe.from), lost ? diminished : major, false)
      }
    }

    // One note per letter: up a major pentatonic for a win, down a minor one for a loss.
    const up = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3]
    const down = [2, 9 / 5, 3 / 2, 4 / 3, 6 / 5]
    cues.letters.forEach((ms, i) => {
      const scale = lost ? down : up
      const octave = lost ? 2 ** -Math.floor(i / 5) : 2 ** Math.floor(i / 5)
      const pitch = 330 * scale[i % 5]! * octave
      this.tone('square', pitch, pitch, at(ms), 0.11, 0.13)
      this.tone('sine', pitch / 2, pitch / 2, at(ms), 0.15, 0.18)
    })

    // The last hit: a riser into it, then a held chord for a win or a sinking glide for a loss.
    const end = at(cues.end)
    this.whoosh(250, 9000, 0.7, 0.4, Math.max(0, end - 0.7))
    this.tone('sine', 140, 30, end, 0.8, 0.8)
    this.crash(end, 0.8, 0.35, 4000)
    if (!gameOver) return
    if (lost) {
      this.tone('sawtooth', 220, 40, end, 1.8, 0.12)
      this.tone('sawtooth', 233, 42, end, 1.8, 0.1)
    } else {
      this.stab(end, 220, major, 1.8, 0.4)
      this.stab(end + 0.12, 440, major, 1.6, 0.25)
    }
  }
}
