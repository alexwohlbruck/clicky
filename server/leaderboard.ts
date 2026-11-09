import type { LeaderboardEntry, Results } from '../shared/protocol'

/**
 * All-time stats by name, kept in one JSON file. There are no accounts, so a
 * name is a player; that's in keeping with a game you join by typing one.
 */
export class Leaderboard {
  private entries = new Map<string, LeaderboardEntry>()
  private writing: Promise<unknown> = Promise.resolve()

  private constructor(private path: string) {}

  static async open(path: string) {
    const board = new Leaderboard(path)
    const file = Bun.file(path)
    if (await file.exists()) {
      try {
        for (const entry of (await file.json()) as LeaderboardEntry[]) board.entries.set(entry.name.toLowerCase(), entry)
      } catch (error) {
        console.error('Leaderboard unreadable; starting fresh', error)
      }
    }
    return board
  }

  record(results: Results) {
    for (const player of results.players) {
      if (player.bot) continue
      const key = player.name.toLowerCase()
      const entry = this.entries.get(key) ?? { name: player.name, games: 0, wins: 0, presses: 0, peakPps: 0 }
      entry.name = player.name
      entry.games++
      if (player.team === results.winner) entry.wins++
      entry.presses += player.presses
      entry.peakPps = Math.max(entry.peakPps, player.peakPps)
      this.entries.set(key, entry)
    }
    // Writes queue behind each other so a slow one can't be overwritten by an older one.
    const snapshot = JSON.stringify([...this.entries.values()])
    this.writing = this.writing.then(() => Bun.write(this.path, snapshot)).catch((error) => console.error(error))
  }

  top(limit = 10) {
    const all = [...this.entries.values()]
    const by = (key: keyof LeaderboardEntry) => [...all].sort((a, b) => (b[key] as number) - (a[key] as number)).slice(0, limit)
    return { wins: by('wins'), presses: by('presses'), peakPps: by('peakPps') }
  }
}
