import { beatLength, dropWithin, nextBeat, type Analysis } from '../shared/music'
import {
  DEFAULT_SETTINGS,
  EMOJI,
  MAX,
  START,
  SURGE,
  TEAMS,
  opponent,
  type BotLevel,
  type ChatMessage,
  type Emoji,
  type Phase,
  type Player,
  type Results,
  type RoomSnapshot,
  type Score,
  type ServerMessage,
  type Settings,
  type Team,
  type Track,
} from '../shared/protocol'

export const COUNTDOWN_MS = 3000
export const ROUND_OVER_MS = 3200
export const GAME_OVER_MS = 6500
export const FRENZY_MS = 4000
/** A player pressing faster than this is a script, not a hand. */
export const MAX_PRESSES_PER_SECOND = 25

const BOT_ID = 'bot'
const BOT_NAME = 'Tong'
/** Milliseconds between bot presses, before jitter. */
const BOT_PACE: Record<Exclude<BotLevel, 'off'>, number> = { easy: 260, normal: 170, hard: 105 }

interface Seat {
  player: Player
  send: (message: ServerMessage) => void
  /** Timestamps of presses in the last second, for rate limiting and stats. */
  recent: number[]
  presses: number
  peakPps: number
  lastReactAt: number
  lastChatAt: number
}

export interface RoomOptions {
  id: string
  public: boolean
  tracks: Track[]
  now: number
  random?: () => number
  /** Called with each finished game, for the leaderboard. */
  onResults?: (results: Results) => void
  /** The analysis of a track, if it's ready, so play can be timed to it. */
  music?: (trackId: string) => Analysis | null
}

/**
 * One game: a shared bar, two teams and a playlist. Time only moves forward
 * through `tick`, so the whole room can be driven deterministically in tests.
 */
export class Room {
  readonly id: string
  readonly public: boolean
  private seats = new Map<string, Seat>()
  private spectators = new Map<string, (message: ServerMessage) => void>()
  private bot: Player | null = null
  private botNextPressAt = 0
  private botPresses = 0
  private hostId: string | null = null

  settings: Settings = { ...DEFAULT_SETTINGS }
  count = START
  score: Score = { creators: 0, destroyers: 0 }
  phase: Phase = 'lobby'
  winner: Team | null = null
  private phaseEndsAt = 0
  private pending: Score = { creators: 0, destroyers: 0 }
  private chat: ChatMessage[] = []
  private frenzyAt = Infinity
  private frenzyUntil = 0
  /** Where the surge orb sits on the bar, in segments, and when the next one appears. */
  orb: number | null = null
  private orbAt = Infinity

  private tracks: Track[]
  private trackIndex: number
  private trackStartedAt: number
  private musicOf: (trackId: string) => Analysis | null
  private frenzyMs = FRENZY_MS
  private tickMs = 1000
  private random: () => number
  private onResults: (results: Results) => void

  constructor({ id, public: isPublic, tracks, now, random = Math.random, onResults = () => {}, music = () => null }: RoomOptions) {
    this.musicOf = music
    this.id = id
    this.public = isPublic
    this.tracks = tracks
    this.random = random
    this.onResults = onResults
    this.trackIndex = Math.floor(random() * tracks.length)
    this.trackStartedAt = now
  }

  get players(): Player[] {
    const humans = [...this.seats.values()].map((seat) => seat.player)
    return this.bot ? [...humans, this.bot] : humans
  }

  get humanCount() {
    return this.seats.size
  }

  get empty() {
    return this.seats.size === 0 && this.spectators.size === 0
  }

  get frenzy() {
    return this.frenzyUntil > 0
  }

  snapshot(): RoomSnapshot {
    return {
      id: this.id,
      spectators: this.spectators.size,
      public: this.public,
      hostId: this.hostId,
      players: this.players,
      settings: this.settings,
      count: this.count,
      score: this.score,
      phase: this.phase,
      winner: this.winner,
    }
  }

  join(id: string, name: string, send: (message: ServerMessage) => void, now: number): Player {
    const player: Player = { id, name: name.trim().slice(0, 16) || 'Anonymous', team: this.smallerTeam() }
    this.seats.set(id, { player, send, recent: [], presses: 0, peakPps: 0, lastReactAt: 0, lastChatAt: 0 })
    this.hostId ??= id
    this.seatBot(now)

    send({ t: 'welcome', you: player, room: this.snapshot() })
    send({ t: 'track', track: this.track, elapsedMs: now - this.trackStartedAt, startedAt: this.trackStartedAt })
    for (const message of this.chat) send({ t: 'chat', message })
    this.broadcastRoom(id)
    return player
  }

  /** Watch without playing: everything a player sees, nothing to press. */
  watch(id: string, send: (message: ServerMessage) => void, now: number) {
    this.spectators.set(id, send)
    send({ t: 'welcome', you: null, room: this.snapshot() })
    send({ t: 'track', track: this.track, elapsedMs: now - this.trackStartedAt, startedAt: this.trackStartedAt })
    for (const message of this.chat) send({ t: 'chat', message })
    this.broadcastRoom(id)
  }

  leave(id: string, now: number) {
    if (this.spectators.delete(id)) return this.broadcastRoom()
    if (!this.seats.delete(id)) return
    if (this.hostId === id) this.hostId = this.seats.keys().next().value ?? null
    this.seatBot(now)
    this.broadcastRoom()
  }

  /** Only the lobby lets players change sides. */
  switchTeam(id: string, team: Team, now: number) {
    const seat = this.seats.get(id)
    if (!seat || this.phase !== 'lobby' || !TEAMS.includes(team)) return
    seat.player.team = team
    this.seatBot(now)
    this.broadcastRoom()
  }

  updateSettings(id: string, settings: Partial<Settings>, now: number) {
    if (id !== this.hostId || this.phase !== 'lobby') return
    const next = { ...this.settings }
    if (settings.roundsToWin && [3, 5, 7].includes(settings.roundsToWin)) next.roundsToWin = settings.roundsToWin
    if (settings.bot && ['off', 'easy', 'normal', 'hard'].includes(settings.bot)) next.bot = settings.bot
    if (typeof settings.frenzy === 'boolean') next.frenzy = settings.frenzy
    this.settings = next
    this.seatBot(now)
    this.broadcastRoom()
  }

  start(id: string, now: number) {
    if (id !== this.hostId || this.phase !== 'lobby') return
    const teams = new Set(this.players.map((player) => player.team))
    if (teams.size < 2) {
      this.seats.get(id)?.send({ t: 'error', message: 'Both teams need a player. Switch sides or turn the bot on.' })
      return
    }
    this.score = { creators: 0, destroyers: 0 }
    for (const seat of this.seats.values()) Object.assign(seat, { presses: 0, peakPps: 0, recent: [] })
    this.botPresses = 0
    // Ticks a whole number of beats apart, as near a second as fits; GO on a
    // downbeat, or on a drop if one is coming up.
    const beat = this.beat(now)
    this.tickMs = beat ? beat * Math.max(1, Math.round(1000 / beat)) : 1000
    const earliest = Math.max(COUNTDOWN_MS - 600, 3 * this.tickMs)
    this.setPhase('countdown', this.moment(now, earliest, earliest + 4000) ?? now + COUNTDOWN_MS, now)
  }

  press(id: string, now: number) {
    const seat = this.seats.get(id)
    if (!seat || this.phase !== 'playing') return

    seat.recent = seat.recent.filter((at) => now - at < 1000)
    if (seat.recent.length >= MAX_PRESSES_PER_SECOND) return
    seat.recent.push(now)
    seat.presses++
    seat.peakPps = Math.max(seat.peakPps, seat.recent.length)

    this.move(seat.player.team, now)
  }

  react(id: string, emoji: Emoji, now: number) {
    const seat = this.seats.get(id)
    if (!seat || !EMOJI.includes(emoji) || now - seat.lastReactAt < 400) return
    seat.lastReactAt = now
    this.broadcast({ t: 'react', id, emoji })
  }

  say(id: string, text: string, now: number) {
    const seat = this.seats.get(id)
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
    if (!seat || !clean || now - seat.lastChatAt < 500) return
    seat.lastChatAt = now
    const message = { id, name: seat.player.name, team: seat.player.team, text: clean, at: now }
    this.chat = [...this.chat.slice(-19), message]
    this.broadcast({ t: 'chat', message })
  }

  /** The host can remove anyone but themselves. */
  kick(id: string, target: string, now: number) {
    const seat = this.seats.get(target)
    if (id !== this.hostId || target === id || !seat) return
    seat.send({ t: 'kicked' })
    this.leave(target, now)
  }

  skipTrack(now: number) {
    this.changeTrack(now)
  }

  /** Advance timers, play the bot, and flush the presses since the last tick. */
  tick(now: number) {
    if ((this.phase === 'countdown' || this.phase === 'roundOver' || this.phase === 'gameOver') && now >= this.phaseEndsAt) {
      if (this.phase === 'gameOver') this.setPhase('lobby', 0, now)
      else this.setPhase('playing', 0, now)
    }

    if (this.phase === 'playing') {
      if (now >= this.frenzyAt) {
        this.frenzyAt = Infinity
        // Eight beats of double time, when there's a beat to count.
        const beat = this.beat(now)
        this.frenzyMs = beat ? Math.min(6000, Math.max(3000, Math.round(beat * 8))) : FRENZY_MS
        this.frenzyUntil = now + this.frenzyMs
        this.broadcast({ t: 'frenzy', active: true, ms: this.frenzyMs })
      } else if (this.frenzyUntil && now >= this.frenzyUntil) {
        this.endFrenzy()
      }

      if (this.orb === null && now >= this.orbAt) this.spawnOrb()

      if (this.bot && now >= this.botNextPressAt) {
        this.botPresses++
        this.move(this.bot.team, now)
        this.botNextPressAt = now + this.botInterval()
      }
    }

    if (now - this.trackStartedAt >= this.track.durationMs) this.changeTrack(now)

    if (this.pending.creators || this.pending.destroyers) {
      this.broadcast({ t: 'state', count: this.count, presses: this.pending, tally: this.tally() })
      this.pending = { creators: 0, destroyers: 0 }
    }
  }

  private get track() {
    return this.tracks[this.trackIndex]!
  }

  private move(team: Team, now: number) {
    const step = this.frenzy ? 2 : 1
    const before = this.count
    this.pending[team]++
    this.count += team === 'creators' ? step : -step

    // Pushing the bar through the orb takes it, and a surge with it.
    if (this.orb !== null && (before - this.orb) * (this.count - this.orb) <= 0 && before !== this.orb) {
      this.orb = null
      this.orbAt = now + this.orbDelay()
      this.count += team === 'creators' ? SURGE : -SURGE
      this.broadcast({ t: 'orb', at: null, by: team })
    }

    if (this.count >= MAX - 1) this.endRound('creators', now)
    else if (this.count <= 1) this.endRound('destroyers', now)
  }

  private endRound(winner: Team, now: number) {
    this.count = Math.min(MAX - 1, Math.max(1, this.count))
    // Let clients see the bar reach the edge before the flash covers it.
    this.broadcast({ t: 'state', count: this.count, presses: this.pending, tally: this.tally() })
    this.pending = { creators: 0, destroyers: 0 }
    this.endFrenzy()
    this.clearOrb()

    this.score[winner]++
    this.winner = winner
    if (this.score[winner] >= this.settings.roundsToWin) {
      this.setPhase('gameOver', now + GAME_OVER_MS, now)
      const results = this.results(winner)
      this.broadcast({ t: 'results', results })
      this.onResults(results)
    } else {
      // The next round starts once the flash has played, on the music if it can.
      this.setPhase('roundOver', this.moment(now, ROUND_OVER_MS, ROUND_OVER_MS + 3500) ?? now + ROUND_OVER_MS, now)
    }
  }

  /** Presses this game, by player. */
  private tally() {
    const tally: Record<string, number> = {}
    for (const [id, seat] of this.seats) tally[id] = seat.presses
    if (this.bot) tally[BOT_ID] = this.botPresses
    return tally
  }

  private results(winner: Team): Results {
    const players = [...this.seats.values()].map(({ player, presses, peakPps }) => ({
      id: player.id,
      name: player.name,
      team: player.team,
      bot: false,
      presses,
      peakPps,
    }))
    if (this.bot) players.push({ id: BOT_ID, name: BOT_NAME, team: this.bot.team, bot: true, presses: this.botPresses, peakPps: 0 })
    const mvp = players.filter((p) => p.team === winner && !p.bot).sort((a, b) => b.presses - a.presses)[0]
    return { winner, score: { ...this.score }, players, mvp: mvp?.id ?? null }
  }

  private setPhase(phase: Phase, endsAt: number, now: number) {
    this.phase = phase
    this.phaseEndsAt = endsAt
    if (phase === 'playing' || phase === 'lobby') {
      this.winner = null
      this.count = START
    }
    if (phase === 'playing') {
      this.botNextPressAt = now + 400
      this.clearOrb()
      this.orbAt = this.onDownbeat(now, now + this.orbDelay())
      // On a drop if one comes in the round's first half-minute; otherwise
      // somewhere in the middle of the round, on a downbeat.
      const drop = this.moment(now, 5000, 30000, true, true)
      this.frenzyAt = !this.settings.frenzy ? Infinity : drop ?? this.onDownbeat(now, now + 6000 + this.random() * 12000)
    }
    this.broadcast({
      t: 'phase',
      phase,
      winner: this.winner,
      score: this.score,
      count: this.count,
      endsInMs: phase === 'countdown' || phase === 'roundOver' ? endsAt - now : undefined,
      endsAt: phase === 'countdown' || phase === 'roundOver' ? endsAt : undefined,
      tickMs: phase === 'countdown' ? this.tickMs : undefined,
    })
  }

  /** The current track's analysis, if ready. */
  private get music() {
    return this.musicOf(this.track.id)
  }

  /** The beat length right now, or null without an analysis. */
  private beat(now: number) {
    const music = this.music
    return music ? beatLength(music, now - this.trackStartedAt) : null
  }

  /**
   * The best musical moment between `from` and `to` ms from now: a drop if
   * there is one (or only a drop, with `dropOnly`), else the first downbeat.
   * Null without an analysis, or if the moment would fall past the song's end.
   */
  private moment(now: number, from: number, to: number, preferDrop = true, dropOnly = false) {
    const music = this.music
    if (!music) return null
    const start = this.trackStartedAt
    const [lo, hi] = [now + from - start, now + to - start]
    const drop = preferDrop ? dropWithin(music, lo, hi) : null
    const at = drop ?? (dropOnly ? null : nextBeat(music, lo, true)?.at ?? null)
    if (at === null || at > hi || at > this.track.durationMs - 500) return null
    return start + at
  }

  /** `at`, moved to the next downbeat if there's music to follow. */
  private onDownbeat(now: number, at: number) {
    return this.moment(now, at - now, at - now + 2500, false) ?? at
  }

  private orbDelay() {
    return 7000 + this.random() * 7000
  }

  /** Somewhere between the 20% and 80% marks, not right under the bar's tip. */
  private spawnOrb() {
    let at = Math.round(20 + this.random() * 60)
    if (Math.abs(at - this.count) < 8) at = this.count + (this.count < START ? 20 : -20)
    this.orb = at
    this.orbAt = Infinity
    this.broadcast({ t: 'orb', at })
  }

  private clearOrb() {
    this.orbAt = Infinity
    if (this.orb === null) return
    this.orb = null
    this.broadcast({ t: 'orb', at: null })
  }

  private endFrenzy() {
    this.frenzyAt = Infinity
    if (!this.frenzyUntil) return
    this.frenzyUntil = 0
    this.broadcast({ t: 'frenzy', active: false, ms: 0 })
  }

  private changeTrack(now: number) {
    if (this.tracks.length > 1) {
      // Pick from every track but the current one.
      const next = Math.floor(this.random() * (this.tracks.length - 1))
      this.trackIndex = next >= this.trackIndex ? next + 1 : next
    }
    this.trackStartedAt = now
    this.broadcast({ t: 'track', track: this.track, elapsedMs: 0, startedAt: now })
  }

  /** Teams fill evenly; ties go to the creators, as they did in the original. */
  private smallerTeam(): Team {
    const humans = [...this.seats.values()].map((seat) => seat.player)
    const creators = humans.filter((player) => player.team === 'creators').length
    return creators <= humans.length - creators ? 'creators' : 'destroyers'
  }

  /** Seat the bot on an empty team, if the host allows one. */
  private seatBot(now: number) {
    const humans = [...this.seats.values()].map((seat) => seat.player)
    const teams = new Set(humans.map((player) => player.team))
    const needsBot = humans.length > 0 && teams.size === 1 && this.settings.bot !== 'off'

    if (!needsBot) {
      this.bot = null
      return
    }

    const team = opponent([...teams][0]!)
    if (this.bot?.team === team) return
    this.bot = { id: BOT_ID, name: BOT_NAME, team, bot: true }
    this.botNextPressAt = now + 1500
  }

  /** Uneven bursts, like a real hand. */
  private botInterval() {
    const pace = BOT_PACE[this.settings.bot === 'off' ? 'normal' : this.settings.bot]
    return pace * (0.5 + this.random())
  }

  private broadcastRoom(exceptId?: string) {
    this.broadcast({ t: 'room', room: this.snapshot() }, exceptId)
  }

  private broadcast(message: ServerMessage, exceptId?: string) {
    for (const [id, seat] of this.seats) if (id !== exceptId) seat.send(message)
    for (const [id, send] of this.spectators) if (id !== exceptId) send(message)
  }
}
