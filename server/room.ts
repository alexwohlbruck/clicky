import {
  MAX,
  ROUNDS_TO_WIN,
  START,
  opponent,
  type Phase,
  type Player,
  type RoomSnapshot,
  type Score,
  type ServerMessage,
  type Team,
  type Track,
} from '../shared/protocol'

export const ROUND_OVER_MS = 3200
export const GAME_OVER_MS = 6500
/** A player pressing faster than this is a script, not a hand. */
export const MAX_PRESSES_PER_SECOND = 25

const BOT_ID = 'bot'
const BOT_NAME = 'Tong'

interface Seat {
  player: Player
  send: (message: ServerMessage) => void
  /** Timestamps of recent presses, for rate limiting. */
  recent: number[]
}

export interface RoomOptions {
  id: string
  tracks: Track[]
  now: number
  random?: () => number
}

/**
 * One game: a shared bar, two teams and a playlist. Time only moves forward
 * through `tick`, so the whole room can be driven deterministically in tests.
 */
export class Room {
  readonly id: string
  private seats = new Map<string, Seat>()
  private bot: Player | null = null
  private botNextPressAt = 0

  count = START
  score: Score = { creators: 0, destroyers: 0 }
  phase: Phase = 'playing'
  winner: Team | null = null
  private phaseEndsAt = 0
  private pending: Score = { creators: 0, destroyers: 0 }

  private tracks: Track[]
  private trackIndex: number
  private trackStartedAt: number
  private random: () => number

  constructor({ id, tracks, now, random = Math.random }: RoomOptions) {
    this.id = id
    this.tracks = tracks
    this.random = random
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

  snapshot(): RoomSnapshot {
    return {
      id: this.id,
      players: this.players,
      count: this.count,
      score: this.score,
      phase: this.phase,
      winner: this.winner,
    }
  }

  join(id: string, name: string, send: (message: ServerMessage) => void, now: number): Player {
    const player: Player = { id, name: name.trim().slice(0, 16) || 'Anonymous', team: this.smallerTeam() }
    this.seats.set(id, { player, send, recent: [] })
    this.seatBot(now)

    send({ t: 'welcome', you: player, room: this.snapshot() })
    send({ t: 'track', track: this.track, elapsedMs: now - this.trackStartedAt })
    this.broadcast({ t: 'players', players: this.players }, id)
    return player
  }

  leave(id: string, now: number) {
    if (!this.seats.delete(id)) return
    this.seatBot(now)
    this.broadcast({ t: 'players', players: this.players })
  }

  press(id: string, now: number) {
    const seat = this.seats.get(id)
    if (!seat || this.phase !== 'playing') return

    seat.recent = seat.recent.filter((at) => now - at < 1000)
    if (seat.recent.length >= MAX_PRESSES_PER_SECOND) return
    seat.recent.push(now)

    this.move(seat.player.team, now)
  }

  skipTrack(now: number) {
    this.changeTrack(now)
  }

  /** Advance timers, play the bot, and flush the presses since the last tick. */
  tick(now: number) {
    if (this.phase !== 'playing' && now >= this.phaseEndsAt) this.nextRound()

    if (this.bot && this.phase === 'playing' && now >= this.botNextPressAt) {
      this.move(this.bot.team, now)
      this.botNextPressAt = now + this.botInterval()
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
    this.pending[team]++
    this.count += team === 'creators' ? 1 : -1

    if (this.count >= MAX - 1) this.endRound('creators', now)
    else if (this.count <= 1) this.endRound('destroyers', now)
  }

  private endRound(winner: Team, now: number) {
    // Let clients see the bar reach the edge before the flash covers it.
    this.broadcast({ t: 'state', count: this.count, presses: this.pending })
    this.pending = { creators: 0, destroyers: 0 }

    this.score[winner]++
    this.winner = winner
    const gameOver = this.score[winner] >= ROUNDS_TO_WIN
    this.phase = gameOver ? 'gameOver' : 'roundOver'
    this.phaseEndsAt = now + (gameOver ? GAME_OVER_MS : ROUND_OVER_MS)
    this.broadcastPhase()
  }

  private nextRound() {
    if (this.phase === 'gameOver') this.score = { creators: 0, destroyers: 0 }
    this.phase = 'playing'
    this.winner = null
    this.count = START
    this.broadcastPhase()
  }

  private broadcastPhase() {
    this.broadcast({ t: 'phase', phase: this.phase, winner: this.winner, score: this.score, count: this.count })
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

  /** Seat the bot on an empty team while anyone is playing alone. */
  private seatBot(now: number) {
    const humans = [...this.seats.values()].map((seat) => seat.player)
    const teams = new Set(humans.map((player) => player.team))
    const needsBot = humans.length > 0 && teams.size === 1

    if (!needsBot) {
      this.bot = null
      return
    }

    const team = opponent([...teams][0]!)
    if (this.bot?.team === team) return
    this.bot = { id: BOT_ID, name: BOT_NAME, team, bot: true }
    this.botNextPressAt = now + 1500
  }

  /** Roughly six presses a second, in uneven bursts like a real hand. */
  private botInterval() {
    return 90 + this.random() * 160
  }

  private broadcast(message: ServerMessage, exceptId?: string) {
    for (const [id, seat] of this.seats) if (id !== exceptId) seat.send(message)
  }
}
