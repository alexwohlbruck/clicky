import { MPEGDecoder } from 'mpg123-decoder'
import { analyze } from './analyze'

/**
 * Downloads, decodes, analyses and keeps one track at a time, off the main thread:
 * decoding a song takes a couple of seconds, and the rooms tick 30 times a
 * second.
 */
declare const self: Worker

self.onmessage = async (event: MessageEvent<{ id: string; url: string; file: string }>) => {
  const { id, url, file } = event.data
  try {
    // A song already kept is analysed again from disk, not downloaded again.
    const kept = Bun.file(file)
    const local = await kept.exists()
    let bytes: Uint8Array
    if (local) bytes = new Uint8Array(await kept.arrayBuffer())
    else {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Fetching ${id} failed: ${response.status}`)
      bytes = new Uint8Array(await response.arrayBuffer())
    }
    const decoder = new MPEGDecoder()
    await decoder.ready
    const { channelData, sampleRate, samplesDecoded } = decoder.decode(bytes)
    decoder.free()
    if (!samplesDecoded) throw new Error(`Decoding ${id} produced no audio`)
    const analysis = analyze(channelData, sampleRate)
    // Kept, so the game can play the song itself: it starts at once and seeks
    // exactly, where Jukebox's live stream takes seconds and can't seek.
    if (!local) await Bun.write(file, bytes)
    self.postMessage({ id, analysis })
  } catch (error) {
    self.postMessage({ id, error: String(error) })
  }
}
