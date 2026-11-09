import type { Results } from '../../shared/protocol'
import type { Profile } from './store'

export interface Achievement {
  id: string
  icon: string
  name: string
  how: string
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-win', icon: '🩸', name: 'First blood', how: 'Win a game' },
  { id: 'veteran', icon: '🎖️', name: 'Veteran', how: 'Play 10 games' },
  { id: 'presses-1000', icon: '🦾', name: 'Carpal tunnel', how: 'Press 1,000 times' },
  { id: 'pps-12', icon: '🐦', name: 'Hummingbird', how: 'Press 12 times in one second' },
  { id: 'pps-18', icon: '🔫', name: 'Machine gun', how: 'Press 18 times in one second' },
  { id: 'mvp', icon: '👑', name: 'Crowned', how: 'Be the MVP' },
  { id: 'flawless', icon: '💎', name: 'Flawless', how: 'Win without dropping a round' },
  { id: 'surge', icon: '🪙', name: 'Golden touch', how: 'Take a surge orb' },
  { id: 'frenzy', icon: '🌈', name: 'Seeing double', how: 'Play through double time' },
]

/** Achievements earned by a finished game, given the profile already updated with it. */
export function earnedByGame(profile: Profile, results: Results, me: string) {
  const mine = results.players.find((p) => p.id === me)
  if (!mine) return []
  const won = mine.team === results.winner
  const loser = mine.team === 'creators' ? 'destroyers' : 'creators'
  const earned: string[] = []
  if (profile.wins >= 1) earned.push('first-win')
  if (profile.games >= 10) earned.push('veteran')
  if (profile.presses >= 1000) earned.push('presses-1000')
  if (profile.peakPps >= 12) earned.push('pps-12')
  if (profile.peakPps >= 18) earned.push('pps-18')
  if (results.mvp === me) earned.push('mvp')
  if (won && results.score[loser] === 0) earned.push('flawless')
  return earned
}
