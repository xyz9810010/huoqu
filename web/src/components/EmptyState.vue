<template>
  <div class="qj-empty">
    <svg class="qj-empty__icon" width="40" height="40" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d="M3 8l9-5 9 5v9l-9 5-9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v9" />
    </svg>
    <p class="qj-empty__title">{{ title }}</p>
    <p v-if="description" class="qj-empty__desc">{{ description }}</p>
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{ title: string; description?: string }>()
</script>
