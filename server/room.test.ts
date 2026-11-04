import { describe, expect, test } from 'bun:test'
import { MAX, ROUNDS_TO_WIN, START, type ServerMessage, type Track } from '../shared/protocol'
import { GAME_OVER_MS, MAX_PRESSES_PER_SECOND, ROUND_OVER_MS, Room } from './room'

const tracks: Track[] = [
  { id: 'a'.repeat(22), track: 'One', artist: 'A', durationMs: 60_000 },
  { id: 'b'.repeat(22), track: 'Two', artist: 'B', durationMs: 60_000 },
]

function setup() {
  const room = new Room({ id: 'test', tracks, now: 0, random: () => 0.5 })
  const inbox = new Map<string, ServerMessage[]>()
  const join = (id: string, now = 0) => {
    inbox.set(id, [])
    return room.join(id, id, (message) => inbox.get(id)!.push(message), now)
  }
  return { room, inbox, join }
}

/** Press as a human would, spaced out enough to stay under the rate limit. */
function mash(room: Room, id: string, times: number, from: number) {
  let now = from
  for (let i = 0; i < times; i++) room.press(id, (now += 100))
  return now
}

describe('Room', () => {
  test('fills teams evenly, creators first', () => {
    const { join } = setup()
    expect(join('p1').team).toBe('creators')
    expect(join('p2').team).toBe('destroyers')
    expect(join('p3').team).toBe('creators')
    expect(join('p4').team).toBe('destroyers')
  })

  test('seats a bot opposite a lone player and removes it when a human arrives', () => {
    const { room, join } = setup()
    join('p1')
    expect(room.players.map((p) => [p.team, !!p.bot])).toEqual([
      ['creators', false],
      ['destroyers', true],
    ])
    join('p2')
    expect(room.players.some((p) => p.bot)).toBe(false)
    room.leave('p2', 0)
    expect(room.players.find((p) => p.bot)?.team).toBe('destroyers')
  })

  test('presses move the bar and are flushed once per tick', () => {
    const { room, inbox, join } = setup()
    join('p1')
    join('p2')
    room.press('p1', 10)
    room.press('p1', 20)
    room.press('p2', 30)
    room.tick(40)
    expect(room.count).toBe(START + 1)
    expect(inbox.get('p1')!.at(-1)).toEqual({ t: 'state', count: START + 1, presses: { creators: 2, destroyers: 1 } })
  })

  test('ignores presses beyond the rate limit', () => {
    const { room, join } = setup()
    join('p1')
    join('p2')
    for (let i = 0; i < MAX_PRESSES_PER_SECOND + 10; i++) room.press('p1', 500)
    expect(room.count).toBe(START + MAX_PRESSES_PER_SECOND)
  })

  test('creators win a round at MAX - 1, then the bar resets', () => {
    const { room, join } = setup()
    join('p1')
    join('p2')
    const now = mash(room, 'p1', MAX - 1 - START, 0)
    expect(room.phase).toBe('roundOver')
    expect(room.winner).toBe('creators')
    expect(room.score).toEqual({ creators: 1, destroyers: 0 })

    room.press('p1', now + 10)
    expect(room.count).toBe(MAX - 1)

    room.tick(now + ROUND_OVER_MS)
    expect(room.phase).toBe('playing')
    expect(room.count).toBe(START)
  })

  test('destroyers win a round at 1', () => {
    const { room, join } = setup()
    join('p1')
    join('p2')
    mash(room, 'p2', START - 1, 0)
    expect(room.winner).toBe('destroyers')
  })

  test(`the first team to ${ROUNDS_TO_WIN} rounds wins the game, and scores reset after`, () => {
    const { room, join } = setup()
    join('p1')
    join('p2')
    let now = 0
    for (let round = 0; round < ROUNDS_TO_WIN; round++) {
      now = mash(room, 'p2', START - 1, now)
      if (round < ROUNDS_TO_WIN - 1) room.tick((now += ROUND_OVER_MS))
    }
    expect(room.phase).toBe('gameOver')
    room.tick(now + GAME_OVER_MS)
    expect(room.phase).toBe('playing')
    expect(room.score).toEqual({ creators: 0, destroyers: 0 })
  })

  test('the bot plays for its team', () => {
    const { room, join } = setup()
    join('p1')
    for (let now = 0; now < 5000; now += 33) room.tick(now)
    expect(room.count).toBeLessThan(START)
  })

  test('changes track when the current one ends', () => {
    const { room, inbox, join } = setup()
    join('p1')
    join('p2')
    room.tick(60_000)
    const sent = inbox.get('p1')!.filter((m) => m.t === 'track')
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ elapsedMs: 0, track: { id: 'a'.repeat(22) } })
  })
})
