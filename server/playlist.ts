import { join } from 'node:path'
import type { Track } from '../shared/protocol'
import bundled from '../shared/tracks.json'

/** The original "Clicky soundtrack" playlist. */
const PLAYLIST_ID = process.env.SPOTIFY_PLAYLIST_ID ?? '4piPcXnIjFKrQ8qoE5ZpZ9'
const HOUR = 60 * 60 * 1000

/**
 * The playlist, kept in step with Spotify: read again every hour, so a song
 * added to (or taken off) the playlist turns up in the game without a
 * deploy. Needs app credentials (SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET);
 * without them, or while Spotify can't be reached, it plays the last list it
 * saw, or the one bundled with the game.
 */
export class Playlist {
  tracks: Track[] = bundled as Track[]
  private file: string
  private token: { value: string; expires: number } | null = null

  private constructor(
    dataDir: string,
    private onChange: (tracks: Track[]) => void,
  ) {
    this.file = join(dataDir, 'playlist.json')
  }

  static async open(dataDir: string, onChange: (tracks: Track[]) => void) {
    const playlist = new Playlist(dataDir, onChange)
    try {
      const saved = (await Bun.file(playlist.file).json()) as Track[]
      if (Array.isArray(saved) && saved.length) playlist.tracks = saved
    } catch {}
    void playlist.sync()
    setInterval(() => void playlist.sync(), HOUR)
    return playlist
  }

  has(id: string) {
    return this.tracks.some((track) => track.id === id)
  }

  async sync() {
    const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret } = process.env
    if (!id || !secret) return
    try {
      const tracks = await this.fetch(id, secret)
      if (!tracks.length) return
      const same = tracks.length === this.tracks.length && tracks.every((track, i) => track.id === this.tracks[i]!.id)
      if (same) return
      const known = new Set(this.tracks.map((track) => track.id))
      const added = tracks.filter((track) => !known.has(track.id)).length
      console.log(`Playlist synced: ${tracks.length} tracks, ${added} new`)
      this.tracks = tracks
      await Bun.write(this.file, JSON.stringify(tracks, null, 2))
      this.onChange(tracks)
    } catch (error) {
      console.warn(`Playlist sync failed: ${error}`)
    }
  }

  private async fetch(id: string, secret: string) {
    const token = await this.authorize(id, secret)
    const tracks: Track[] = []
    const fields = 'next,items(is_local,track(id,name,duration_ms,artists(name)))'
    let url: string | null = `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks?limit=100&fields=${encodeURIComponent(fields)}`
    while (url) {
      const response: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      if (!response.ok) throw new Error(`Spotify answered ${response.status}`)
      const page = (await response.json()) as {
        next: string | null
        items: { is_local: boolean; track: { id: string | null; name: string; duration_ms: number; artists: { name: string }[] } | null }[]
      }
      for (const { is_local, track } of page.items) {
        // Local files and tracks gone from Spotify can't be streamed.
        if (is_local || !track?.id) continue
        tracks.push({ id: track.id, track: track.name, artist: track.artists[0]?.name ?? '', durationMs: track.duration_ms })
      }
      url = page.next
    }
    return tracks
  }

  private async authorize(id: string, secret: string) {
    if (this.token && Date.now() < this.token.expires) return this.token.value
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`${id}:${secret}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    })
    if (!response.ok) throw new Error(`Spotify token request answered ${response.status}`)
    const { access_token, expires_in } = (await response.json()) as { access_token: string; expires_in: number }
    this.token = { value: access_token, expires: Date.now() + (expires_in - 60) * 1000 }
    return access_token
  }
}
