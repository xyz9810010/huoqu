<template>
  <div class="qj-skeleton" :aria-busy="true" :aria-label="label">
    <div v-for="i in rows" :key="i" class="qj-skeleton__bar"
         :style="{ width: widths[(i - 1) % widths.length] }" />
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  rows?: number
  widths?: string[]
  label?: string
}>(), {
  rows: 4,
  widths: () => ['40%', '100%', '92%', '96%', '64%'],
  label: '加载中',
})
</script>
