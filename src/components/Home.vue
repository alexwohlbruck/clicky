<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { LeaderboardEntry, RoomListing } from '../../shared/protocol'
import { actions, state } from '../game/store'

const code = ref(new URLSearchParams(location.search).get('room') ?? '')
const rooms = ref<RoomListing[]>([])
const board = ref<Record<'wins' | 'presses' | 'peakPps', LeaderboardEntry[]> | null>(null)
const boardTab = ref<'wins' | 'presses' | 'peakPps'>('wins')
const nameInput = ref<HTMLInputElement>()

const named = computed(() => state.profile.name.trim().length > 0)
const winRate = computed(() => (state.profile.games ? Math.round((state.profile.wins / state.profile.games) * 100) : 0))

function needName(then: () => void) {
  if (!named.value) {
    state.error = 'Pick a name first'
    nameInput.value?.focus()
    return
  }
  then()
}

async function refresh() {
  try {
    const [r, b] = await Promise.all([fetch('/api/rooms').then((x) => x.json()), fetch('/api/leaderboard').then((x) => x.json())])
    rooms.value = r
    board.value = b
  } catch {}
}

let timer = 0
onMounted(() => {
  void refresh()
  timer = window.setInterval(refresh, 4000)
  if (!named.value) nameInput.value?.focus()
})
onUnmounted(() => clearInterval(timer))

const boardValue = (entry: LeaderboardEntry) =>
  boardTab.value === 'wins' ? `${entry.wins} W` : boardTab.value === 'presses' ? entry.presses.toLocaleString() : `${entry.peakPps}/s`

const phaseLabel = { lobby: 'In lobby', countdown: 'Starting', playing: 'Playing', roundOver: 'Playing', gameOver: 'Finishing' }
</script>

<template>
  <main class="home">
    <header class="hero">
      <h1 class="wordmark">Clicky</h1>
      <p class="tagline">To destroy or not to destroy.</p>
    </header>

    <section class="panel play">
      <label class="field">
        <span>Your name</span>
        <input
          ref="nameInput"
          v-model="state.profile.name"
          maxlength="16"
          placeholder="Enter your name"
          autocomplete="nickname"
          enterkeyhint="go"
          @keydown.enter="needName(actions.quickPlay)"
        />
      </label>

      <button class="btn primary big" @click="needName(actions.quickPlay)">
        <span>Quick play</span><small>Jump into a public game</small>
      </button>

      <div class="row">
        <button class="btn" @click="needName(actions.createRoom)">Create private room</button>
        <form class="join" @submit.prevent="needName(() => actions.joinRoom(code))">
          <input v-model="code" maxlength="4" placeholder="CODE" class="code" aria-label="Room code" />
          <button class="btn" :disabled="code.length !== 4">Join</button>
        </form>
      </div>
    </section>

    <section class="panel rooms">
      <h2>Open games</h2>
      <p v-if="!rooms.length" class="muted">No one's playing right now. Start one!</p>
      <ul v-else>
        <li v-for="room in rooms" :key="room.id">
          <span class="room-code">{{ room.id }}</span>
          <span class="muted">{{ phaseLabel[room.phase] }} · {{ room.players }}/10</span>
          <span class="score" v-if="room.phase !== 'lobby'">{{ room.score.destroyers }}–{{ room.score.creators }}</span>
          <button class="btn small" @click="needName(() => actions.joinRoom(room.id))">Join</button>
        </li>
      </ul>
    </section>

    <section class="panel stats">
      <h2>Your stats</h2>
      <dl>
        <div><dt>Games</dt><dd>{{ state.profile.games }}</dd></div>
        <div><dt>Win rate</dt><dd>{{ winRate }}%</dd></div>
        <div><dt>Presses</dt><dd>{{ state.profile.presses.toLocaleString() }}</dd></div>
        <div><dt>Fastest</dt><dd>{{ state.profile.peakPps }}<small>/s</small></dd></div>
      </dl>
    </section>

    <section class="panel board">
      <div class="board-head">
        <h2>Leaderboard</h2>
        <div class="segmented">
          <button :class="{ on: boardTab === 'wins' }" @click="boardTab = 'wins'">Wins</button>
          <button :class="{ on: boardTab === 'presses' }" @click="boardTab = 'presses'">Presses</button>
          <button :class="{ on: boardTab === 'peakPps' }" @click="boardTab = 'peakPps'">Fastest</button>
        </div>
      </div>
      <ol v-if="board && board[boardTab].length">
        <li v-for="(entry, i) in board[boardTab]" :key="entry.name" :class="{ me: entry.name.toLowerCase() === state.profile.name.toLowerCase() }">
          <span class="rank">{{ i + 1 }}</span>
          <span class="name">{{ entry.name }}</span>
          <span class="value">{{ boardValue(entry) }}</span>
        </li>
      </ol>
      <p v-else class="muted">Finish a game to get on the board.</p>
    </section>
  </main>
</template>
