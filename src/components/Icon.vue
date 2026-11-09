<script setup lang="ts">
/** Stroke icons for controls, so buttons don't depend on emoji fonts. */
const PATHS = {
  back: 'M15 18l-6-6 6-6',
  share: 'M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 002 2h10a2 2 0 002-2v-5',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  tv: 'M3 6h18v12H3zM8 21h8',
  volume: 'M4 9.5h3.5L12 5v14l-4.5-4.5H4zM16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11',
  mute: 'M4 9.5h3.5L12 5v14l-4.5-4.5H4zM16.5 9.5l5 5M21.5 9.5l-5 5',
  skip: 'M5 5l10 7-10 7zM19 5v14',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  close: 'M6 6l12 12M18 6L6 18',
  crown: 'M3.5 8l4.5 4 4-7 4 7 4.5-4-2 11h-13z',
  bot: 'M5 9h14v10H5zM12 5v4M9 13.5v1M15 13.5v1M2.5 13v3M21.5 13v3',
  swap: 'M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4',
  play: 'M7 4.5l13 7.5-13 7.5z',
  plus: 'M12 5v14M5 12h14',
  bolt: 'M13 3L5 13.5h6L10 21l9-11h-6z',
  vibrate: 'M8 4h8v16H8zM4 8v8M20 8v8',
  still: 'M8 4h8v16H8zM3 3l18 18',
} as const

defineProps<{ name: keyof typeof PATHS; size?: number }>()
</script>

<template>
  <svg
    class="i"
    :width="size ?? 20"
    :height="size ?? 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="PATHS[name]" />
  </svg>
</template>
