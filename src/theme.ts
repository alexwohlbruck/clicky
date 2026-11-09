import { reactive } from 'vue'

/**
 * The game's colours, as a theme the player picks. Each names what a colour
 * is for, not what it looks like; everything else (inks for text, button
 * shadows, panel surfaces, glows) is mixed from these in the stylesheet, and
 * the background and particles read the same values as shader uniforms.
 */
export interface Theme {
  id: string
  name: string
  /** The builders' half. */
  creators: string
  /** The destroyers' half. */
  destroyers: string
  /** The progress bar's fill. */
  bar: string
  /** Buttons, your own name, highlights. */
  accent: string
  /** Wins, achievements, streaks, the orb. */
  gold: string
  /** The frame around the field, and what panels are made of. */
  frame: string
  /** The two colours text and the picture fringe into when things shake. */
  fringe: [string, string]
}

export const THEMES: Theme[] = [
  {
    id: 'swapped',
    name: 'Clicky',
    creators: '#0091ea',
    destroyers: '#e91e63',
    bar: '#37474f',
    accent: '#e91e63',
    gold: '#ffd23f',
    frame: '#1f282d',
    fringe: ['#ff005a', '#00e6ff'],
  },
  {
    id: 'classic',
    name: 'Classic',
    creators: '#0091ea',
    destroyers: '#37474f',
    bar: '#e91e63',
    accent: '#e91e63',
    gold: '#ffd23f',
    frame: '#1f282d',
    fringe: ['#ff005a', '#00e6ff'],
  },
  {
    id: 'acid',
    name: 'Acid',
    creators: '#00c853',
    destroyers: '#4a148c',
    bar: '#ffea00',
    accent: '#d500f9',
    gold: '#ffea00',
    frame: '#120d18',
    fringe: ['#d500f9', '#76ff03'],
  },
  {
    id: 'sunset',
    name: 'Sunset',
    creators: '#ff6d00',
    destroyers: '#311b92',
    bar: '#ff1744',
    accent: '#ff3d00',
    gold: '#ffc400',
    frame: '#1a1020',
    fringe: ['#ff1744', '#7c4dff'],
  },
  {
    id: 'ice',
    name: 'Ice',
    creators: '#00b8d4',
    destroyers: '#455a64',
    bar: '#2962ff',
    accent: '#00b8d4',
    gold: '#b2ff59',
    frame: '#0d1b24',
    fringe: ['#2962ff', '#18ffff'],
  },
  {
    id: 'mono',
    name: 'Mono',
    creators: '#8a8a8a',
    destroyers: '#212121',
    bar: '#ff1744',
    accent: '#ff1744',
    gold: '#ffffff',
    frame: '#111111',
    fringe: ['#ff1744', '#ffffff'],
  },
]

const KEY = 'clicky-theme'

export const theme = reactive({
  current: THEMES.find((t) => t.id === localStorage.getItem(KEY)) ?? THEMES[0]!,
})

const listeners = new Set<(theme: Theme) => void>()

/** Called now and whenever the theme changes. */
export function onTheme(listener: (theme: Theme) => void) {
  listeners.add(listener)
  listener(theme.current)
  return () => listeners.delete(listener)
}

export function setTheme(id: string) {
  const next = THEMES.find((t) => t.id === id)
  if (!next) return
  theme.current = next
  localStorage.setItem(KEY, id)
  apply(next)
}

function apply(t: Theme) {
  const style = document.documentElement.style
  style.setProperty('--creators', t.creators)
  style.setProperty('--destroyers', t.destroyers)
  style.setProperty('--bar', t.bar)
  style.setProperty('--accent', t.accent)
  style.setProperty('--gold', t.gold)
  style.setProperty('--frame', t.frame)
  style.setProperty('--fringe-a', t.fringe[0])
  style.setProperty('--fringe-b', t.fringe[1])
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.frame)
  for (const listener of listeners) listener(t)
}

apply(theme.current)
