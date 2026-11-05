<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Home from './components/Home.vue'
import Room from './components/Room.vue'
import { introGesture, sound, startEffects } from './game/effects'
import { EMOJI } from '../shared/protocol'
import { actions, state } from './game/store'

const canvas = ref<HTMLCanvasElement>()
const touch = matchMedia('(pointer: coarse)').matches

onMounted(() => startEffects(canvas.value!))

const typing = (event: Event) => (event.target as HTMLElement).closest('input, textarea, select')

addEventListener('keydown', (event) => {
  if (introGesture()) return
  // 1-6 send the reactions, in the order they appear on screen.
  const reaction = EMOJI[Number(event.key) - 1]
  if (reaction && state.screen === 'room' && !typing(event)) actions.react(reaction)
  if (event.code === 'Space' && !event.repeat && state.screen === 'room' && !typing(event)) {
    event.preventDefault()
    actions.press()
  }
})

function onPointer(event: PointerEvent) {
  if (introGesture()) return
  const target = event.target as HTMLElement
  if (target.closest('button:not(:disabled)')) sound.click()
  if (target.closest('button, input, a, select, .card, .reactions')) return
  if (state.screen === 'room' && state.room?.phase === 'playing') {
    event.preventDefault()
    actions.press()
  }
}
</script>

<template>
  <div id="stage" :class="`screen-${state.screen}`" @pointerdown="onPointer">
    <canvas id="fx" ref="canvas"></canvas>
    <div id="frame"></div>

    <Transition name="fade" mode="out-in">
      <Home v-if="state.screen === 'home'" />
      <Room v-else-if="state.screen === 'room'" />
    </Transition>

    <div id="chips"></div>

    <div id="flash">
      <h1 id="flash-text"></h1>
      <p id="flash-prompt">{{ touch ? 'Tap to start' : 'Press any key' }}</p>
      <p id="flash-warning">
        Warning: this game contains rapidly flashing lights and strobe effects that may trigger seizures in people with
        photosensitive epilepsy.
      </p>
    </div>

    <Transition name="toast">
      <div v-if="state.unlocked" :key="state.unlocked.id" class="toast achievement">
        <span class="trophy">{{ state.unlocked.icon }}</span>
        <span><small>Achievement unlocked</small><strong>{{ state.unlocked.name }}</strong></span>
      </div>
    </Transition>

    <Transition name="toast">
      <div v-if="state.error" class="toast" @click="state.error = ''">{{ state.error }}</div>
    </Transition>
  </div>
</template>
