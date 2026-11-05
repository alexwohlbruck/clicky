import { createApp } from 'vue'
import App from './App.vue'
import { sound } from './game/effects'
import { clock, state } from './game/store'
import './style.css'

createApp(App).mount('#app')

// For poking at from the console while developing.
if (import.meta.env.DEV) Object.assign(window, { clicky: { sound, state, clock } })
