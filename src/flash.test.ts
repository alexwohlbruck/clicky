import { expect, test } from 'bun:test'
import { Flash, INTRO, type FlashEvent } from './flash'

const fakeElement = () => ({ textContent: '', style: {} as Record<string, string> }) as unknown as HTMLElement

/** Play the intro at 60 fps and note when each event fired. */
function play(fps = 60) {
  const events: { ms: number; event: FlashEvent }[] = []
  let now = 0
  const flash = new Flash(INTRO, 'clicky', fakeElement(), (event) => events.push({ ms: now, event }))
  for (now = 0; !flash.done && now < 12_000; now += 1000 / fps) flash.update(now)
  return events
}

const NOTE = 159.57
const onNote = (ms: number) => {
  const n = (ms - 353.7) / NOTE
  return Math.abs(n - Math.round(n)) * NOTE
}

test('every letter and size change lands within a frame of a note', () => {
  const events = play()
  const beats = events.filter(({ event }) => event.type === 'letter' || event.type === 'size' || event.type === 'warp')
  expect(beats.length).toBeGreaterThan(15)
  for (const { ms } of beats) expect(onNote(ms)).toBeLessThan(1000 / 60 + 1)
})

test('types "clicky" and ends on the hit after the break', () => {
  const events = play()
  expect(events.filter(({ event }) => event.type === 'letter')).toHaveLength(6)
  const end = events.find(({ event }) => event.type === 'end')!
  expect(end.ms).toBeGreaterThanOrEqual(9667)
  expect(end.ms).toBeLessThan(9667 + 17)
})

test('the slow strobe flips on every other note', () => {
  const toggles = play().filter(({ event }) => event.type === 'toggle' && event.period > 100)
  expect(toggles.length).toBe(8)
  for (const { ms } of toggles) expect(onNote(ms)).toBeLessThan(17)
})

test('a strobe faster than the frame rate flips at most once a frame', () => {
  const toggles = play(30).filter(({ event }) => event.type === 'toggle' && event.period < 100)
  const frames = new Set(toggles.map(({ ms }) => ms))
  expect(frames.size).toBe(toggles.length)
})
