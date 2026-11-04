<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { EMOJI, type BotLevel, type Team } from '../../shared/protocol'
import { display, sound } from '../game/effects'
import { actions, state } from '../game/store'

const room = computed(() => state.room!)
const me = computed(() => state.me!)
const isHost = computed(() => room.value.hostId === me.value?.id)
const inLobby = computed(() => room.value.phase === 'lobby')
const touch = matchMedia('(pointer: coarse)').matches

const teamPlayers = (team: Team) => room.value.players.filter((p) => p.team === team)
const teams: { team: Team; label: string; verb: string }[] = [
  { team: 'destroyers', label: 'Destroyers', verb: 'destroy' },
  { team: 'creators', label: 'Creators', verb: 'create' },
]

// Values that change every frame, read from the effects loop.
const percent = ref(50)
const countdown = ref(0)
const pps = ref(0)
const frenzyLeft = ref(0)
const surging = ref(false)
let raf = 0
function tick() {
  const now = performance.now()
  percent.value = Math.round(display.progress * 100)
  countdown.value = Math.max(0, Math.ceil((state.countdownEndsAt - now) / 1000))
  pps.value = state.myRecent.filter((at) => now - at < 1000).length
  frenzyLeft.value = Math.max(0, (state.frenzyUntil - now) / 1000)
  surging.value = !!state.surge && state.surge.until > now
  raf = requestAnimationFrame(tick)
}
onMounted(() => (raf = requestAnimationFrame(tick)))
onUnmounted(() => cancelAnimationFrame(raf))

const muted = ref(sound.muted)
function toggleMute() {
  sound.muted = !sound.muted
  muted.value = sound.muted
}

const copied = ref(false)
async function copyInvite() {
  const url = `${location.origin}${location.pathname}?room=${room.value.id}`
  try {
    if (navigator.share && touch) await navigator.share({ title: 'Play Clicky with me', url })
    else await navigator.clipboard.writeText(url)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch {}
}

const draft = ref('')
const chatList = ref<HTMLElement>()
function say() {
  if (!draft.value.trim()) return
  actions.say(draft.value)
  draft.value = ''
}
watch(
  () => state.chat.length,
  () => nextTick(() => chatList.value?.scrollTo({ top: chatList.value.scrollHeight, behavior: 'smooth' })),
)

const bots: BotLevel[] = ['off', 'easy', 'normal', 'hard']
const results = computed(() => state.results)
/** Badges for the results table, beyond the MVP. */
const awards = computed(() => {
  const players = results.value?.players.filter((p) => !p.bot) ?? []
  const badges = new Map<string, string[]>()
  const give = (id: string | undefined, badge: string) => id && badges.set(id, [...(badges.get(id) ?? []), badge])
  give(results.value?.mvp ?? undefined, '👑 MVP')
  const fastest = [...players].sort((a, b) => b.peakPps - a.peakPps)[0]
  if (fastest?.peakPps) give(fastest.id, '⚡ Fastest fingers')
  const most = [...players].sort((a, b) => b.presses - a.presses)[0]
  if (most && most.id !== results.value?.mvp) give(most.id, '💪 Most presses')
  return badges
})
const sortedResults = computed(() => [...(results.value?.players ?? [])].sort((a, b) => b.presses - a.presses))
</script>

<template>
  <main class="room" :class="[`phase-${room.phase}`, `team-${me.team}`]">
    <!-- Lobby ------------------------------------------------------------- -->
    <section v-if="inLobby" class="lobby">
      <header class="lobby-head">
        <button class="btn ghost" @click="actions.leave()">← Leave</button>
        <div class="code-block">
          <span class="muted">{{ room.public ? 'Public room' : 'Room code' }}</span>
          <strong class="room-code big">{{ room.id }}</strong>
        </div>
        <button class="btn" @click="copyInvite">{{ copied ? 'Copied!' : 'Invite' }}</button>
      </header>

      <div class="teams">
        <div v-for="t in teams" :key="t.team" class="panel team" :class="t.team">
          <h2>{{ t.label }}</h2>
          <ul>
            <li v-for="p in teamPlayers(t.team)" :key="p.id" :class="{ me: p.id === me.id }">
              <span>{{ p.bot ? '🤖' : p.id === room.hostId ? '👑' : '•' }}</span>
              {{ p.name }}
              <small v-if="p.id === me.id">you</small>
              <button v-if="isHost && !p.bot && p.id !== me.id" class="kick" :aria-label="`Remove ${p.name}`" @click="actions.kick(p.id)">✕</button>
            </li>
          </ul>
          <button v-if="me.team !== t.team" class="btn small" @click="actions.switchTeam(t.team)">Switch to {{ t.label.toLowerCase() }}</button>
          <p v-else class="muted">Your job: {{ t.verb }}</p>
        </div>
      </div>

      <div class="panel settings">
        <h2>Settings <small v-if="!isHost" class="muted">· host only</small></h2>
        <div class="setting">
          <span>First to</span>
          <div class="segmented">
            <button v-for="n in [3, 5, 7] as const" :key="n" :class="{ on: room.settings.roundsToWin === n }" :disabled="!isHost" @click="actions.settings({ roundsToWin: n })">{{ n }}</button>
          </div>
        </div>
        <div class="setting">
          <span>Tong the bot</span>
          <div class="segmented">
            <button v-for="b in bots" :key="b" :class="{ on: room.settings.bot === b }" :disabled="!isHost" @click="actions.settings({ bot: b })">{{ b }}</button>
          </div>
        </div>
        <div class="setting">
          <span>Double time <small class="muted">random ×2 bursts</small></span>
          <div class="segmented">
            <button :class="{ on: room.settings.frenzy }" :disabled="!isHost" @click="actions.settings({ frenzy: true })">on</button>
            <button :class="{ on: !room.settings.frenzy }" :disabled="!isHost" @click="actions.settings({ frenzy: false })">off</button>
          </div>
        </div>
      </div>

      <div class="panel chat">
        <h2>Chat</h2>
        <ul ref="chatList">
          <li v-if="!state.chat.length" class="muted">Talk some trash before the game.</li>
          <li v-for="m in state.chat" :key="m.at + m.id">
            <strong :class="m.team">{{ m.name }}</strong> {{ m.text }}
          </li>
        </ul>
        <form @submit.prevent="say">
          <input v-model="draft" maxlength="140" placeholder="Say something…" enterkeyhint="send" />
          <button class="btn small" :disabled="!draft.trim()">Send</button>
        </form>
      </div>

      <button v-if="isHost" class="btn primary big start" @click="actions.start()">Start game</button>
      <p v-else class="waiting">Waiting for the host to start…</p>
    </section>

    <!-- In game (the original layout) --------------------------------------- -->
    <section v-else class="hud">
      <div class="corner tl">
        <p>{{ touch ? 'Tap' : 'Spacebar' }}</p>
        <p class="small-text">{{ me.team === 'creators' ? 'Add segment' : 'Remove segment' }}</p>
        <div class="pps" :class="{ fire: pps >= 10 }"><strong>{{ pps }}</strong>/s · {{ state.myPresses }} presses</div>
        <Transition name="pop"><div v-if="pps >= 10" class="on-fire">🔥 On fire</div></Transition>
      </div>

      <div class="corner tr music" v-if="state.track">
        <p class="track-name">{{ state.track.track }}</p>
        <p class="small-text">{{ state.track.artist }}</p>
        <div class="icons">
          <button class="icon" @click="toggleMute" :aria-label="muted ? 'Unmute' : 'Mute'">{{ muted ? '🔇' : '🔊' }}</button>
          <button class="icon" @click="actions.skip()" aria-label="Skip track">⏭</button>
        </div>
      </div>

      <div class="middle">
        <h2 class="call">{{ me.team === 'creators' ? 'create' : 'destroy' }}</h2>
        <div id="bar"></div>
        <h1 class="percent">{{ percent }}%</h1>
      </div>

      <div class="scores">
        <h3 class="white">Destroyers {{ room.score.destroyers }}</h3>
        <span class="target">first to {{ room.settings.roundsToWin }}</span>
        <h3>{{ room.score.creators }} Creators</h3>
      </div>

      <Transition name="pop">
        <div v-if="room.phase === 'countdown' && countdown > 0" :key="countdown" class="countdown">{{ countdown }}</div>
      </Transition>

      <Transition name="pop">
        <div v-if="frenzyLeft > 0" class="frenzy">
          <strong>Double time</strong>
          <span>×2 · {{ frenzyLeft.toFixed(1) }}s</span>
        </div>
      </Transition>

      <Transition name="pop">
        <div v-if="surging && state.surge" class="surge" :class="state.surge.team">
          <strong>Surge!</strong>
          <span>+6 to the {{ state.surge.team }}</span>
        </div>
      </Transition>

      <div class="reactions panel">
        <button v-for="(e, i) in EMOJI" :key="e" :title="touch ? undefined : `Press ${i + 1}`" @click="actions.react(e)">{{ e }}</button>
      </div>
    </section>

    <div class="floaters">
      <span v-for="r in state.reactions" :key="r.key" class="floater" :class="r.team" :style="{ left: `${10 + r.x * 80}%` }">{{ r.emoji }}</span>
    </div>

    <!-- Rosters along the bottom, as in the original -------------------------- -->
    <footer class="players">
      <div class="roster destroyers">
        <p v-for="p in teamPlayers('destroyers')" :key="p.id" :class="{ me: p.id === me.id, bot: p.bot }">
          {{ p.name }}<span v-if="!inLobby" class="tally">{{ state.tally[p.id] ?? 0 }}</span>
        </p>
      </div>
      <div class="title"><h1>Clicky</h1></div>
      <div class="roster creators">
        <p v-for="p in teamPlayers('creators')" :key="p.id" :class="{ me: p.id === me.id, bot: p.bot }">
          {{ p.name }}<span v-if="!inLobby" class="tally">{{ state.tally[p.id] ?? 0 }}</span>
        </p>
      </div>
    </footer>

    <!-- Results ----------------------------------------------------------- -->
    <Transition name="fade">
      <div v-if="state.showResults && results" class="results-backdrop">
        <section class="panel results">
          <p class="muted">Game over · {{ results.score.destroyers }}–{{ results.score.creators }}</p>
          <h1 :class="results.winner">{{ results.winner }} win</h1>
          <p class="verdict">{{ results.winner === me.team ? 'You won! 🎉' : 'How unfortunate.' }}</p>
          <table>
            <thead>
              <tr><th>Player</th><th>Presses</th><th>Fastest</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in sortedResults" :key="p.id" :class="[p.team, { me: p.id === me.id }]">
                <td>
                  {{ p.name }}
                  <span v-for="badge in awards.get(p.id)" :key="badge" class="badge">{{ badge }}</span>
                </td>
                <td>{{ p.presses }}</td>
                <td>{{ p.bot ? '—' : `${p.peakPps}/s` }}</td>
              </tr>
            </tbody>
          </table>
          <div class="row">
            <button class="btn ghost" @click="actions.leave()">Leave</button>
            <button class="btn primary" @click="state.showResults = false">Back to lobby</button>
          </div>
        </section>
      </div>
    </Transition>
  </main>
</template>
