import {
  DEFAULT_SETTINGS,
  EMOJI,
  MAX,
  START,
  TEAMS,
  opponent,
  type BotLevel,
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
}

export interface RoomOptions {
  id: string
  public: boolean
  tracks: Track[]
  now: number
  random?: () => number
  /** Called with each finished game, for the leaderboard. */
  onResults?: (results: Results) => void
}

/**
 * One game: a shared bar, two teams and a playlist. Time only moves forward
 * through `tick`, so the whole room can be driven deterministically in tests.
 */
export class Room {
  readonly id: string
  readonly public: boolean
  private seats = new Map<string, Seat>()
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
  private frenzyAt = Infinity
  private frenzyUntil = 0

  private tracks: Track[]
  private trackIndex: number
  private trackStartedAt: number
  private random: () => number
  private onResults: (results: Results) => void

  constructor({ id, public: isPublic, tracks, now, random = Math.random, onResults = () => {} }: RoomOptions) {
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

  get frenzy() {
    return this.frenzyUntil > 0
  }

  snapshot(): RoomSnapshot {
    return {
      id: this.id,
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
    this.seats.set(id, { player, send, recent: [], presses: 0, peakPps: 0, lastReactAt: 0 })
    this.hostId ??= id
    this.seatBot(now)

    send({ t: 'welcome', you: player, room: this.snapshot() })
    send({ t: 'track', track: this.track, elapsedMs: now - this.trackStartedAt })
    this.broadcastRoom(id)
    return player
  }

  leave(id: string, now: number) {
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
    this.setPhase('countdown', now + COUNTDOWN_MS, now)
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
        this.frenzyUntil = now + FRENZY_MS
        this.broadcast({ t: 'frenzy', active: true, ms: FRENZY_MS })
      } else if (this.frenzyUntil && now >= this.frenzyUntil) {
        this.endFrenzy()
      }

      if (this.bot && now >= this.botNextPressAt) {
        this.botPresses++
        this.move(this.bot.team, now)
        this.botNextPressAt = now + this.botInterval()
      }
    }

    if (now - this.trackStartedAt >= this.track.durationMs) this.changeTrack(now)

    if (this.pending.creators || this.pending.destroyers) {
      this.broadcast({ t: 'state', count: this.count, presses: this.pending })
      this.pending = { creators: 0, destroyers: 0 }
    }
  }

  private get track() {
    return this.tracks[this.trackIndex]!
  }

  private move(team: Team, now: number) {
    const step = this.frenzy ? 2 : 1
    this.pending[team]++
    this.count += team === 'creators' ? step : -step

    if (this.count >= MAX - 1) this.endRound('creators', now)
    else if (this.count <= 1) this.endRound('destroyers', now)
  }

  private endRound(winner: Team, now: number) {
    this.count = Math.min(MAX - 1, Math.max(1, this.count))
    // Let clients see the bar reach the edge before the flash covers it.
    this.broadcast({ t: 'state', count: this.count, presses: this.pending })
    this.pending = { creators: 0, destroyers: 0 }
    this.endFrenzy()

    this.score[winner]++
    this.winner = winner
    if (this.score[winner] >= this.settings.roundsToWin) {
      this.setPhase('gameOver', now + GAME_OVER_MS, now)
      const results = this.results(winner)
      this.broadcast({ t: 'results', results })
      this.onResults(results)
    } else {
      this.setPhase('roundOver', now + ROUND_OVER_MS, now)
    }
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
      // Somewhere in the middle of the round, if it lasts that long.
      this.frenzyAt = this.settings.frenzy ? now + 6000 + this.random() * 12000 : Infinity
    }
    this.broadcast({
      t: 'phase',
      phase,
      winner: this.winner,
      score: this.score,
      count: this.count,
      countdownMs: phase === 'countdown' ? COUNTDOWN_MS : undefined,
    })
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
    this.broadcast({ t: 'track', track: this.track, elapsedMs: 0 })
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
  }
}
