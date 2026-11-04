<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { LeaderboardEntry, RoomListing } from '../../shared/protocol'
import { ACHIEVEMENTS } from '../game/achievements'
import { actions, state } from '../game/store'
import Icon from './Icon.vue'

const params = new URLSearchParams(location.search)
const code = ref(params.get('room') ?? params.get('watch') ?? '')
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
  // A TV link goes straight to the room.
  if (params.get('watch')) actions.watch(params.get('watch')!)
  void refresh()
  timer = window.setInterval(refresh, 4000)
  if (!named.value) nameInput.value?.focus()
})
onUnmounted(() => clearInterval(timer))

const boardValue = (entry: LeaderboardEntry) =>
  boardTab.value === 'wins' ? `${entry.wins} W` : boardTab.value === 'presses' ? entry.presses.toLocaleString() : `${entry.peakPps}/s`

const phaseLabel = { lobby: 'In lobby', countdown: 'Starting', playing: 'Playing', roundOver: 'Playing', gameOver: 'Finishing' }
const earned = computed(() => ACHIEVEMENTS.filter((a) => state.profile.achievements.includes(a.id)).length)
</script>

<template>
  <main class="home scroll">
    <div class="home-grid">
      <header class="hero">
        <h1 class="wordmark">Clicky</h1>
        <p class="tagline">To destroy or not to destroy</p>
      </header>

      <div class="col">
      <section class="card play">
        <label class="field">
          <span class="label">Your name</span>
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

        <button class="btn primary hero-btn" @click="needName(actions.quickPlay)">
          <span>Quick play</span>
          <small>Jump into a public game</small>
        </button>

        <div class="divider"><span>or play with friends</span></div>

        <div class="play-row">
          <button class="btn" @click="needName(actions.createRoom)"><Icon name="plus" :size="18" /> New room</button>
          <form class="join" @submit.prevent="needName(() => actions.joinRoom(code))">
            <input v-model="code" maxlength="4" placeholder="Code" class="code-input" aria-label="Room code" autocapitalize="characters" autocomplete="off" spellcheck="false" />
            <button class="btn" :disabled="code.length !== 4">Join</button>
            <button type="button" class="btn icon-btn" :disabled="code.length !== 4" title="Show this room on a big screen" aria-label="Watch on a big screen" @click="actions.watch(code)">
              <Icon name="tv" :size="18" />
            </button>
          </form>
        </div>
      </section>

      <section class="card stats">
        <header class="card-head">
          <h2 class="label">Your stats</h2>
        </header>
        <dl>
          <div><dt>Games</dt><dd>{{ state.profile.games }}</dd></div>
          <div><dt>Win rate</dt><dd>{{ winRate }}<small>%</small></dd></div>
          <div><dt>Presses</dt><dd>{{ state.profile.presses.toLocaleString() }}</dd></div>
          <div><dt>Fastest</dt><dd>{{ state.profile.peakPps }}<small>/s</small></dd></div>
        </dl>
        <header class="card-head sub">
          <h3 class="label">Achievements</h3>
          <span class="count">{{ earned }}/{{ ACHIEVEMENTS.length }}</span>
        </header>
        <ul class="achievements">
          <li v-for="a in ACHIEVEMENTS" :key="a.id" :class="{ got: state.profile.achievements.includes(a.id) }" :title="`${a.name}: ${a.how}`">
            {{ a.icon }}
          </li>
        </ul>
      </section>
      </div>

      <div class="col">
      <section class="card rooms">
        <header class="card-head">
          <h2 class="label">Open games</h2>
          <span v-if="rooms.length" class="live"><i></i>{{ rooms.length }} live</span>
        </header>
        <p v-if="!rooms.length" class="empty">Nobody's playing right now. Start a game and they'll come.</p>
        <ul v-else class="list">
          <li v-for="room in rooms" :key="room.id" class="room-row">
            <span class="chip mono">{{ room.id }}</span>
            <span class="room-meta">
              <span>{{ phaseLabel[room.phase] }}</span>
              <small>{{ room.players }}/10 players<template v-if="room.phase !== 'lobby'"> · {{ room.score.destroyers }}–{{ room.score.creators }}</template></small>
            </span>
            <button class="btn icon-btn quiet" title="Watch on a big screen" aria-label="Watch on a big screen" @click="actions.watch(room.id)"><Icon name="tv" :size="18" /></button>
            <button class="btn small" @click="needName(() => actions.joinRoom(room.id))">Join</button>
          </li>
        </ul>
      </section>



      <section class="card board">
        <header class="card-head">
          <h2 class="label">Leaderboard</h2>
          <div class="segmented">
            <button :class="{ on: boardTab === 'wins' }" @click="boardTab = 'wins'">Wins</button>
            <button :class="{ on: boardTab === 'presses' }" @click="boardTab = 'presses'">Presses</button>
            <button :class="{ on: boardTab === 'peakPps' }" @click="boardTab = 'peakPps'">Fastest</button>
          </div>
        </header>
        <ol v-if="board && board[boardTab].length" class="list">
          <li v-for="(entry, i) in board[boardTab]" :key="entry.name" class="board-row" :class="{ me: entry.name.toLowerCase() === state.profile.name.toLowerCase(), first: i === 0 }">
            <span class="rank">{{ i + 1 }}</span>
            <span class="name">{{ entry.name }}</span>
            <span class="value">{{ boardValue(entry) }}</span>
          </li>
        </ol>
        <p v-else class="empty">Finish a game to get on the board.</p>
      </section>
      </div>
    </div>
  </main>
</template>
