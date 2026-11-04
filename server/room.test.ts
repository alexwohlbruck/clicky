import { describe, expect, test } from 'bun:test'
import { MAX, START, type Results, type ServerMessage, type Track } from '../shared/protocol'
import { COUNTDOWN_MS, GAME_OVER_MS, MAX_PRESSES_PER_SECOND, ROUND_OVER_MS, Room } from './room'

const tracks: Track[] = [
  { id: 'a'.repeat(22), track: 'One', artist: 'A', durationMs: 600_000 },
  { id: 'b'.repeat(22), track: 'Two', artist: 'B', durationMs: 600_000 },
]

function setup() {
  const finished: Results[] = []
  const room = new Room({ id: 'TEST', public: true, tracks, now: 0, random: () => 0.5, onResults: (r) => finished.push(r) })
  room.settings.frenzy = false
  const inbox = new Map<string, ServerMessage[]>()
  const join = (id: string, now = 0) => {
    inbox.set(id, [])
    return room.join(id, id, (message) => inbox.get(id)!.push(message), now)
  }
  /** Host starts, and the countdown runs out. */
  const begin = (now = 0) => {
    room.start('p1', now)
    room.tick(now + COUNTDOWN_MS)
    return now + COUNTDOWN_MS
  }
  return { room, inbox, join, begin, finished }
}

/** Press as a human would, spaced out enough to stay under the rate limit. */
function mash(room: Room, id: string, times: number, from: number) {
  let now = from
  for (let i = 0; i < times; i++) room.press(id, (now += 100))
  return now
}

describe('Room', () => {
  test('fills teams evenly, creators first, and the first player hosts', () => {
    const { room, join } = setup()
    expect(join('p1').team).toBe('creators')
    expect(join('p2').team).toBe('destroyers')
    expect(join('p3').team).toBe('creators')
    expect(room.snapshot().hostId).toBe('p1')
    room.leave('p1', 0)
    expect(room.snapshot().hostId).toBe('p2')
  })

  test('waits in the lobby until the host starts, then counts down', () => {
    const { room, join } = setup()
    join('p1')
    join('p2')
    room.press('p1', 10)
    expect(room.count).toBe(START)
    room.start('p2', 0)
    expect(room.phase).toBe('lobby')
    room.start('p1', 0)
    expect(room.phase).toBe('countdown')
    room.tick(COUNTDOWN_MS)
    expect(room.phase).toBe('playing')
  })

  test('seats a bot opposite a lone player, unless the host turns it off', () => {
    const { room, join } = setup()
    join('p1')
    expect(room.players.find((p) => p.bot)?.team).toBe('destroyers')
    room.updateSettings('p1', { bot: 'off' }, 0)
    expect(room.players.some((p) => p.bot)).toBe(false)
  })

  test('players can switch teams in the lobby only', () => {
    const { room, join, begin } = setup()
    join('p1')
    join('p2')
    room.switchTeam('p2', 'creators', 0)
    expect(room.players.find((p) => p.id === 'p2')?.team).toBe('creators')
    room.switchTeam('p2', 'destroyers', 0)
    begin()
    room.switchTeam('p2', 'creators', 0)
    expect(room.players.find((p) => p.id === 'p2')?.team).toBe('destroyers')
  })

  test('presses move the bar and are flushed once per tick', () => {
    const { room, inbox, join, begin } = setup()
    join('p1')
    join('p2')
    const now = begin()
    room.press('p1', now + 10)
    room.press('p1', now + 20)
    room.press('p2', now + 30)
    room.tick(now + 40)
    expect(room.count).toBe(START + 1)
    expect(inbox.get('p1')!.at(-1)).toEqual({ t: 'state', count: START + 1, presses: { creators: 2, destroyers: 1 }, tally: { p1: 2, p2: 1 } })
  })

  test('ignores presses beyond the rate limit', () => {
    const { room, join, begin } = setup()
    join('p1')
    join('p2')
    const now = begin()
    for (let i = 0; i < MAX_PRESSES_PER_SECOND + 10; i++) room.press('p1', now + 500)
    expect(room.count).toBe(START + MAX_PRESSES_PER_SECOND)
  })

  test('a round ends at the edge, then the bar resets', () => {
    const { room, join, begin } = setup()
    join('p1')
    join('p2')
    let now = mash(room, 'p1', MAX - 1 - START, begin())
    expect(room.phase).toBe('roundOver')
    expect(room.score).toEqual({ creators: 1, destroyers: 0 })
    room.tick((now += ROUND_OVER_MS))
    expect(room.phase).toBe('playing')
    expect(room.count).toBe(START)
  })

  test('the game ends at the chosen number of rounds, with results and an MVP', () => {
    const { room, join, begin, finished } = setup()
    join('p1')
    join('p2')
    room.updateSettings('p1', { roundsToWin: 3 }, 0)
    let now = begin()
    for (let round = 0; round < 3; round++) {
      now = mash(room, 'p2', START - 1, now)
      if (round < 2) room.tick((now += ROUND_OVER_MS))
    }
    expect(room.phase).toBe('gameOver')
    expect(finished[0]).toMatchObject({ winner: 'destroyers', mvp: 'p2' })
    expect(finished[0]!.players.find((p) => p.id === 'p2')).toMatchObject({ presses: (START - 1) * 3, peakPps: 10 })
    room.tick(now + GAME_OVER_MS)
    expect(room.phase).toBe('lobby')
  })

  test('double time makes each press count twice', () => {
    const { room, join, begin } = setup()
    join('p1')
    join('p2')
    room.settings.frenzy = true
    const now = begin()
    room.tick(now + 20_000)
    expect(room.frenzy).toBe(true)
    room.press('p1', now + 20_001)
    expect(room.count).toBe(START + 2)
  })

  test('the bot plays for its team', () => {
    const { room, join, begin } = setup()
    join('p1')
    const start = begin()
    for (let now = start; now < start + 5000; now += 33) room.tick(now)
    expect(room.count).toBeLessThan(START)
  })

  test('reactions are rate limited', () => {
    const { room, inbox, join } = setup()
    join('p1')
    room.react('p1', '🔥', 1000)
    room.react('p1', '🔥', 1100)
    room.react('p1', '💀', 1500)
    expect(inbox.get('p1')!.filter((m) => m.t === 'react')).toHaveLength(2)
  })
  test('chat is trimmed, rate limited, and replayed to late joiners', () => {
    const { room, inbox, join } = setup()
    join('p1')
    room.say('p1', '  gg   ez  ', 1000)
    room.say('p1', 'spam', 1100)
    join('p2', 2000)
    const seen = inbox.get('p2')!.filter((m) => m.t === 'chat')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ message: { text: 'gg ez', name: 'p1' } })
  })

  test('only the host can kick, and not themselves', () => {
    const { room, inbox, join } = setup()
    join('p1')
    join('p2')
    room.kick('p2', 'p1', 0)
    room.kick('p1', 'p1', 0)
    expect(room.humanCount).toBe(2)
    room.kick('p1', 'p2', 0)
    expect(room.humanCount).toBe(1)
    expect(inbox.get('p2')!.at(-1)).toEqual({ t: 'kicked' })
  })
})
