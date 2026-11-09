# Clicky 2

To destroy or not to destroy - that is the question.

A rebuild of [Clicky](https://github.com/alexwohlbruck/clicky) (2017): two teams, one bar, a spacebar each. Builders fill the bar, destroyers empty it. Reach the edge to take the round; first to five rounds wins.

Same layout and type as the original, with a WebGPU layer underneath for the chaos: the halves fight over territory as the bar moves, presses throw sparks and debris, a losing half falls apart, and round wins land with a shockwave and confetti. The intro keeps the original keyframes, timed to the original music.

## Stack

- **Client:** Vite + TypeScript. Text and layout are plain DOM; the canvas behind them is three.js `WebGPURenderer` with TSL shaders, which falls back to WebGL2. Particles are simulated in a compute shader.
- **Server:** Bun, with native WebSockets. The server owns the bar; clients predict their own presses.
- **Music:** the original "Clicky soundtrack" playlist (`shared/tracks.json`), streamed through [Jukebox](https://github.com/alexwohlbruck/jukebox) and proxied by the server so Web Audio can analyse it.

## Running

    bun install
    bun run dev      # vite on :3700, game server on :3701
    bun test

    bun run build
    bun run start    # serves dist/ and the game on :3700

`?room=name` joins a private room. `?webgl` forces the WebGL2 fallback.
