export type Team = 'creators' | 'destroyers'

export const TEAMS: readonly Team[] = ['creators', 'destroyers']

/** Segments in the bar. Creators win at `MAX - 1`, destroyers at 1. */
export const MAX = 100
export const START = MAX / 2
export const ROUNDS_TO_WIN = 5
export const ROOM_CAPACITY = 10

export interface Player {
  id: string
  name: string
  team: Team
  /** Stands in for a missing opponent until a real player takes its seat. */
  bot?: boolean
}

export type Phase = 'playing' | 'roundOver' | 'gameOver'

export type Score = Record<Team, number>

export interface Track {
  id: string
  track: string
  artist: string
  durationMs: number
}

export interface RoomSnapshot {
  id: string
  players: Player[]
  count: number
  score: Score
  phase: Phase
  winner: Team | null
}

export type ServerMessage =
  | { t: 'welcome'; you: Player; room: RoomSnapshot }
  | { t: 'players'; players: Player[] }
  /** Sent at most once per tick, with the presses that produced the change. */
  | { t: 'state'; count: number; presses: Score }
  | { t: 'phase'; phase: Phase; winner: Team | null; score: Score; count: number }
  /** `elapsedMs` is how far into the track the room is, as of sending. */
  | { t: 'track'; track: Track; elapsedMs: number }

export type ClientMessage =
  | { t: 'join'; name: string; room?: string }
  | { t: 'press' }
  | { t: 'skip' }

export const opponent = (team: Team): Team => (team === 'creators' ? 'destroyers' : 'creators')
