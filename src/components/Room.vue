<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { EMOJI, TEAM_NAME, TEAM_VERB, type BotLevel, type Team } from '../../shared/protocol'
import { display, sound } from '../game/effects'
import { actions, state } from '../game/store'
import Icon from './Icon.vue'
import { haptics } from '../haptics'

const room = computed(() => state.room!)
/** Spectators get a stand-in so the layout can read a team; nothing they do is sent. */
const spectating = computed(() => !state.me)
const me = computed(() => state.me ?? { id: '', name: '', team: 'creators' as Team })
const inviteUrl = computed(() => `${location.host}${location.pathname}?room=${room.value.id}`)
const isHost = computed(() => room.value.hostId === me.value?.id)
const inLobby = computed(() => room.value.phase === 'lobby')
const touch = matchMedia('(pointer: coarse)').matches

const teamPlayers = (team: Team) => room.value.players.filter((p) => p.team === team)
const teams: { team: Team; label: string; verb: string }[] = [
  { team: 'destroyers', label: 'Destroyers', verb: TEAM_VERB.destroyers },
  { team: 'creators', label: 'Builders', verb: TEAM_VERB.creators },
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
  countdown.value = Math.min(3, Math.max(0, Math.ceil((state.countdownEndsAt - now) / state.tickMs)))
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

const canBuzz = touch && haptics.supported
const buzzing = ref(haptics.enabled)
function toggleHaptics() {
  haptics.enabled = !haptics.enabled
  buzzing.value = haptics.enabled
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
const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?'
const sortedResults = computed(() => [...(results.value?.players ?? [])].sort((a, b) => b.presses - a.presses))
</script>

<template>
  <main class="room" :class="[`phase-${room.phase}`, `team-${me.team}`]">
    <!-- Lobby ------------------------------------------------------------- -->
    <section v-if="inLobby" class="lobby scroll">
      <div class="lobby-grid">
        <header class="topbar">
          <button class="btn icon-btn" aria-label="Leave room" title="Leave" @click="actions.leave()"><Icon name="back" /></button>
          <div class="room-id">
            <span class="label">{{ room.public ? 'Public room' : 'Room code' }}</span>
            <strong>{{ room.id }}</strong>
          </div>
          <button class="btn" @click="copyInvite">
            <Icon :name="copied ? 'check' : 'share'" :size="18" />
            {{ copied ? 'Copied' : 'Invite' }}
          </button>
        </header>

        <div class="teams">
          <section v-for="t in teams" :key="t.team" class="card team" :class="[t.team, { mine: !spectating && me.team === t.team }]">
            <header class="team-head">
              <h2>{{ t.label }}</h2>
              <span class="count">{{ teamPlayers(t.team).length }}</span>
            </header>
            <ul class="people">
              <li v-for="p in teamPlayers(t.team)" :key="p.id" :class="{ me: p.id === me.id }">
                <span class="avatar" :class="{ bot: p.bot }">
                  <Icon v-if="p.bot" name="bot" :size="16" />
                  <template v-else>{{ initial(p.name) }}</template>
                </span>
                <span class="who">{{ p.name }}</span>
                <Icon v-if="p.id === room.hostId" name="crown" :size="15" class="host" />
                <span v-if="p.id === me.id" class="you">You</span>
                <button v-if="isHost && !p.bot && p.id !== me.id" class="kick" :aria-label="`Remove ${p.name}`" title="Remove" @click="actions.kick(p.id)">
                  <Icon name="close" :size="14" />
                </button>
              </li>
              <li v-if="!teamPlayers(t.team).length" class="nobody">Nobody yet</li>
            </ul>
            <button v-if="!spectating && me.team !== t.team" class="btn small switch" @click="actions.switchTeam(t.team)">
              <Icon name="swap" :size="16" /> Switch
            </button>
            <p v-else-if="!spectating" class="job">Your job: <strong>{{ t.verb }}</strong></p>
          </section>
        </div>

        <section class="card settings">
          <header class="card-head">
            <h2 class="label">Settings</h2>
            <span v-if="!isHost" class="count">Host only</span>
          </header>
          <div class="setting">
            <span class="setting-name">First to<small>Rounds needed to win</small></span>
            <div class="segmented">
              <button v-for="n in [3, 5, 7] as const" :key="n" :class="{ on: room.settings.roundsToWin === n }" :disabled="!isHost" @click="actions.settings({ roundsToWin: n })">{{ n }}</button>
            </div>
          </div>
          <div class="setting">
            <span class="setting-name">Tong the bot<small>Fills in for missing players</small></span>
            <div class="segmented">
              <button v-for="b in bots" :key="b" :class="{ on: room.settings.bot === b }" :disabled="!isHost" @click="actions.settings({ bot: b })">{{ b }}</button>
            </div>
          </div>
          <div class="setting">
            <span class="setting-name">Double time<small>Random bursts where presses count ×2</small></span>
            <div class="segmented">
              <button :class="{ on: room.settings.frenzy }" :disabled="!isHost" @click="actions.settings({ frenzy: true })">On</button>
              <button :class="{ on: !room.settings.frenzy }" :disabled="!isHost" @click="actions.settings({ frenzy: false })">Off</button>
            </div>
          </div>
        </section>

        <section class="card chat">
          <header class="card-head">
            <h2 class="label">Chat</h2>
          </header>
          <ul ref="chatList">
            <li v-if="!state.chat.length" class="nobody">Talk some trash before the game.</li>
            <li v-for="m in state.chat" :key="m.at + m.id">
              <strong :class="m.team">{{ m.name }}</strong>{{ m.text }}
            </li>
          </ul>
          <form v-if="!spectating" @submit.prevent="say">
            <input v-model="draft" maxlength="140" placeholder="Say something…" enterkeyhint="send" aria-label="Message" />
            <button class="btn icon-btn" :disabled="!draft.trim()" aria-label="Send"><Icon name="send" :size="18" /></button>
          </form>
        </section>

        <div class="lobby-cta">
          <button v-if="isHost" class="btn primary hero-btn" @click="actions.start()"><span>Start game</span></button>
          <div v-else-if="spectating" class="card tv-join">
            <span class="label">Join on your phone</span>
            <strong>{{ inviteUrl }}</strong>
          </div>
          <p v-else class="waiting">Waiting for the host to start…</p>
        </div>
      </div>
    </section>

    <!-- In game (the original layout) --------------------------------------- -->
    <section v-else class="hud">
      <div v-if="spectating" class="corner tl">
        <p>Watching</p>
        <p class="sub">Join with code</p>
        <p class="tv-code">{{ room.id }}</p>
      </div>
      <div v-else class="corner tl">
        <p>{{ touch ? 'Tap' : 'Spacebar' }}</p>
        <p class="sub">{{ me.team === 'creators' ? 'Add segment' : 'Remove segment' }}</p>
        <div class="pps" :class="{ fire: pps >= 10 }"><strong>{{ pps }}</strong>/s<span class="dot">·</span>{{ state.myPresses }}</div>
        <Transition name="pop"><div v-if="pps >= 10" class="on-fire">On fire</div></Transition>
      </div>

      <div v-if="state.track" class="corner tr music">
        <div class="np">
          <p class="track-name">{{ state.track.track }}</p>
          <p class="sub">{{ state.track.artist }}</p>
        </div>
        <div class="np-buttons">
          <button v-if="canBuzz" class="round-btn" :aria-label="buzzing ? 'Turn off vibration' : 'Turn on vibration'" @click="toggleHaptics"><Icon :name="buzzing ? 'vibrate' : 'still'" :size="18" /></button>
          <button class="round-btn" :aria-label="muted ? 'Unmute' : 'Mute'" @click="toggleMute"><Icon :name="muted ? 'mute' : 'volume'" :size="18" /></button>
          <button class="round-btn" aria-label="Skip track" @click="actions.skip()"><Icon name="skip" :size="18" /></button>
        </div>
      </div>

      <div class="middle">
        <h2 class="call" :style="{ visibility: spectating ? 'hidden' : undefined }">{{ TEAM_VERB[me.team] }}</h2>
        <div id="bar"></div>
        <h1 class="percent">{{ percent }}%</h1>
      </div>

      <div class="scores">
        <div class="score destroyers"><span>Destroyers</span><strong>{{ room.score.destroyers }}</strong></div>
        <span class="target">First to {{ room.settings.roundsToWin }}</span>
        <div class="score creators"><strong>{{ room.score.creators }}</strong><span>Builders</span></div>
      </div>

      <Transition name="pop">
        <div v-if="room.phase === 'countdown' && countdown > 0" :key="countdown" class="countdown">{{ countdown }}</div>
      </Transition>

      <Transition name="pop">
        <div v-if="frenzyLeft > 0" class="banner frenzy">
          <strong>Double time</strong>
          <span>×2 · {{ frenzyLeft.toFixed(1) }}s</span>
        </div>
      </Transition>

      <Transition name="pop">
        <div v-if="surging && state.surge" class="banner surge" :class="state.surge.team">
          <strong>Surge!</strong>
          <span>+6 to the {{ TEAM_NAME[state.surge.team] }}</span>
        </div>
      </Transition>

      <div v-if="!spectating" class="reactions">
        <button v-for="(e, i) in EMOJI" :key="e" :title="touch ? undefined : `Press ${i + 1}`" :aria-label="`React ${e}`" @click="actions.react(e)">{{ e }}</button>
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
        <section class="card results">
          <p class="label">Game over</p>
          <h1 :class="results.winner">{{ TEAM_NAME[results.winner] }} win</h1>
          <p class="final">
            <span class="destroyers">{{ results.score.destroyers }}</span>
            <span class="dash">–</span>
            <span class="creators">{{ results.score.creators }}</span>
          </p>
          <p v-if="!spectating" class="verdict">{{ results.winner === me.team ? 'You won! 🎉' : 'How unfortunate.' }}</p>
          <ol class="result-list">
            <li v-for="p in sortedResults" :key="p.id" :class="[p.team, { me: p.id === me.id }]">
              <span class="avatar" :class="{ bot: p.bot }">
                <Icon v-if="p.bot" name="bot" :size="16" />
                <template v-else>{{ initial(p.name) }}</template>
              </span>
              <span class="who">
                {{ p.name }}
                <span v-if="awards.get(p.id)" class="badges">
                  <span v-for="badge in awards.get(p.id)" :key="badge" class="badge">{{ badge }}</span>
                </span>
              </span>
              <span class="stat"><strong>{{ p.presses }}</strong><small>presses</small></span>
              <span class="stat"><strong>{{ p.bot ? '—' : p.peakPps }}</strong><small>best /s</small></span>
            </li>
          </ol>
          <div class="actions">
            <button class="btn" @click="actions.leave()">Leave</button>
            <button class="btn primary" @click="state.showResults = false">Back to lobby</button>
          </div>
        </section>
      </div>
    </Transition>
  </main>
</template>
