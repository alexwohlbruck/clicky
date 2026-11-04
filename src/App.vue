<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Home from './components/Home.vue'
import Room from './components/Room.vue'
import { introGesture, startEffects } from './game/effects'
import { actions, state } from './game/store'

const canvas = ref<HTMLCanvasElement>()
const touch = matchMedia('(pointer: coarse)').matches

onMounted(() => startEffects(canvas.value!))

const typing = (event: Event) => (event.target as HTMLElement).closest('input, textarea, select')

addEventListener('keydown', (event) => {
  if (introGesture()) return
  if (event.code === 'Space' && !event.repeat && state.screen === 'room' && !typing(event)) {
    event.preventDefault()
    actions.press()
  }
})

function onPointer(event: PointerEvent) {
  if (introGesture()) return
  const target = event.target as HTMLElement
  if (target.closest('button, input, a, select, .panel')) return
  if (state.screen === 'room' && state.room?.phase === 'playing') {
    event.preventDefault()
    actions.press()
  }
}
</script>

<template>
  <div id="stage" @pointerdown="onPointer">
    <canvas id="fx" ref="canvas"></canvas>
    <div id="frame"></div>

    <Transition name="fade" mode="out-in">
      <Home v-if="state.screen === 'home'" />
      <Room v-else-if="state.screen === 'room'" />
    </Transition>

    <div id="flash">
      <h1 id="flash-text"></h1>
      <p id="flash-prompt">{{ touch ? 'Tap to start' : 'Press any key' }}</p>
      <p id="flash-warning">
        Warning: this game contains rapidly flashing lights and strobe effects that may trigger seizures in people with
        photosensitive epilepsy.
      </p>
    </div>

    <Transition name="toast">
      <div v-if="state.error" class="toast" @click="state.error = ''">{{ state.error }}</div>
    </Transition>
  </div>
</template>
