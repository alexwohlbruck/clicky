import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ANALYSIS_VERSION, type Analysis } from '../shared/music'

/**
 * Track analyses: in memory, then on disk, then worked out by the worker.
 * One track at a time, so warming the playlist never competes with a game.
 */
export class Analyses {
  private memory = new Map<string, Analysis>()
  private pending = new Map<string, Promise<Analysis | null>>()
  private queue: { id: string; resolve: (analysis: Analysis | null) => void }[] = []
  private busy = false
  private worker: Worker | null = null
  private dir: string
  private songs: string

  constructor(
    dataDir: string,
    /** Where to download a whole track from. */
    private source: (id: string) => string,
  ) {
    this.dir = join(dataDir, 'analysis')
    this.songs = join(dataDir, 'music')
  }

  /** The song's own file, kept when it was analysed. */
  song(id: string) {
    return Bun.file(join(this.songs, `${id}.mp3`))
  }

  /** Already known, without waiting. */
  peek(id: string) {
    return this.memory.get(id) ?? null
  }

  /**
   * The analysis, worked out if need be. `urgent` is for a song someone is
   * listening to now: it goes ahead of the background warm-up.
   */
  get(id: string, urgent = false): Promise<Analysis | null> {
    const known = this.memory.get(id)
    if (known) return Promise.resolve(known)
    if (urgent) {
      const queued = this.queue.findIndex((job) => job.id === id)
      if (queued > 0) this.queue.unshift(...this.queue.splice(queued, 1))
    }
    let pending = this.pending.get(id)
    if (!pending) {
      pending = this.load(id, urgent).finally(() => this.pending.delete(id))
      this.pending.set(id, pending)
    }
    return pending
  }

  /** Work through a playlist in the background, skipping what's cached. */
  async warm(ids: string[]) {
    for (const id of ids) await this.get(id)
  }

  private async load(id: string, urgent: boolean) {
    const file = Bun.file(join(this.dir, `${id}.json`))
    if ((await file.exists()) && (await this.song(id).exists())) {
      try {
        const analysis = (await file.json()) as Analysis
        if (analysis.version === ANALYSIS_VERSION) {
          this.memory.set(id, analysis)
          return analysis
        }
      } catch {}
    }
    const analysis = await new Promise<Analysis | null>((resolve) => {
      if (urgent) this.queue.unshift({ id, resolve })
      else this.queue.push({ id, resolve })
      this.next()
    })
    if (analysis) {
      this.memory.set(id, analysis)
      await Bun.write(file, JSON.stringify(analysis))
    }
    return analysis
  }

  private next() {
    if (this.busy) return
    const job = this.queue.shift()
    if (!job) return
    this.busy = true
    this.worker ??= new Worker(new URL('./analysis-worker.ts', import.meta.url))
    const started = performance.now()
    this.worker.onmessage = (event: MessageEvent<{ id: string; analysis?: Analysis; error?: string }>) => {
      if (event.data.id !== job.id) return
      if (event.data.error) console.warn(`Analysis of ${job.id} failed: ${event.data.error}`)
      else console.log(`Analysed ${job.id} in ${Math.round(performance.now() - started)} ms: ${event.data.analysis!.bpm} BPM, ${event.data.analysis!.drops.length} drops`)
      job.resolve(event.data.analysis ?? null)
      this.busy = false
      this.next()
    }
    void Promise.all([mkdir(this.dir, { recursive: true }), mkdir(this.songs, { recursive: true })]).then(() =>
      this.worker!.postMessage({ id: job.id, url: this.source(job.id), file: join(this.songs, `${job.id}.mp3`) }),
    )
  }
}
