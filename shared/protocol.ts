export type Team = 'creators' | 'destroyers'

export const TEAMS: readonly Team[] = ['creators', 'destroyers']

/** What players see. The creators were renamed the builders; the id stayed. */
export const TEAM_NAME: Record<Team, string> = { creators: 'builders', destroyers: 'destroyers' }
/** What each side does to the bar. */
export const TEAM_VERB: Record<Team, string> = { creators: 'build', destroyers: 'destroy' }

/** Segments in the bar. Creators win at `MAX - 1`, destroyers at 1. */
export const MAX = 100
export const START = MAX / 2
export const ROOM_CAPACITY = 10

export const EMOJI = ['🔥', '😂', '💀', '😤', '👏', '🫡'] as const
export type Emoji = (typeof EMOJI)[number]

export type BotLevel = 'off' | 'easy' | 'normal' | 'hard'

export interface Settings {
  roundsToWin: 3 | 5 | 7
  bot: BotLevel
  /** Random "double time" windows where every press counts twice. */
  frenzy: boolean
}

export const DEFAULT_SETTINGS: Settings = { roundsToWin: 5, bot: 'normal', frenzy: true }

export interface Player {
  id: string
  name: string
  team: Team
  /** Stands in for a missing opponent until a real player takes its seat. */
  bot?: boolean
}

/**
 * `lobby` waits for the host; `countdown` is the 3-2-1; a round is `playing`
 * until someone reaches the edge.
 */
export type Phase = 'lobby' | 'countdown' | 'playing' | 'roundOver' | 'gameOver'

export type Score = Record<Team, number>

export interface Track {
  id: string
  track: string
  artist: string
  durationMs: number
}

export interface RoomSnapshot {
  id: string
  /** People watching on a big screen, not playing. */
  spectators: number
  public: boolean
  hostId: string | null
  players: Player[]
  settings: Settings
  count: number
  score: Score
  phase: Phase
  winner: Team | null
}

export interface PlayerResult {
  id: string
  name: string
  team: Team
  bot: boolean
  presses: number
  /** Most presses in any one second. */
  peakPps: number
}

export interface Results {
  winner: Team
  score: Score
  players: PlayerResult[]
  /** Most presses on the winning side. */
  mvp: string | null
}

export interface ChatMessage {
  id: string
  name: string
  team: Team
  text: string
  at: number
}

export interface RoomListing {
  id: string
  players: number
  phase: Phase
  score: Score
}

export interface LeaderboardEntry {
  name: string
  games: number
  wins: number
  presses: number
  peakPps: number
}

export type ServerMessage =
  /** `you` is null when watching rather than playing. */
  | { t: 'welcome'; you: Player | null; room: RoomSnapshot }
  | { t: 'room'; room: RoomSnapshot }
  /** Sent at most once per tick, with the presses that produced the change. */
  | { t: 'state'; count: number; presses: Score; tally: Record<string, number> }
  /**
   * `endsInMs` is when a countdown or round-over gives way to play, timed to
   * the music; `tickMs` spaces the countdown's ticks, a whole number of beats.
   */
  | { t: 'phase'; phase: Phase; winner: Team | null; score: Score; count: number; endsInMs?: number; endsAt?: number; tickMs?: number }
  | { t: 'results'; results: Results }
  /**
   * `elapsedMs` is how far into the track the room is, as of sending;
   * `startedAt` is when it started, on the server's clock (see `pong`).
   */
  | { t: 'track'; track: Track; elapsedMs: number; startedAt: number }
  /** The server's clock, answering a `ping`, so timings can be read on ours. */
  | { t: 'pong'; at: number; server: number }
  | { t: 'react'; id: string; emoji: Emoji }
  | { t: 'frenzy'; active: boolean; ms: number }
  | { t: 'chat'; message: ChatMessage }
  /** A surge orb appeared on the bar at `at` segments, or was taken by `by`. */
  | { t: 'orb'; at: number | null; by?: Team }
  /** The host removed you from the room. */
  | { t: 'kicked' }
  | { t: 'error'; message: string }

export type ClientMessage =
  /** `room` joins that code; `create` opens a new room; neither is quick play. */
  | { t: 'join'; name: string; room?: string; create?: boolean; watch?: boolean }
  | { t: 'press' }
  /** `at` is the client's clock, echoed back in the `pong`. */
  | { t: 'ping'; at: number }
  | { t: 'skip' }
  | { t: 'team'; team: Team }
  | { t: 'start' }
  | { t: 'settings'; settings: Partial<Settings> }
  | { t: 'react'; emoji: Emoji }
  | { t: 'chat'; text: string }
  | { t: 'kick'; id: string }

/** Segments a team gains for pushing the bar through a surge orb. */
export const SURGE = 6

export const opponent = (team: Team): Team => (team === 'creators' ? 'destroyers' : 'creators')
