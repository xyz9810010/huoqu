<template>
  <header class="page-head" :class="{ 'page-head--sticky': sticky }">
    <div class="page-head__main">
      <h2 class="page-title">{{ title }}</h2>
      <p v-if="description" class="page-description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="page-head__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  description?: string
  sticky?: boolean
}>(), { description: '', sticky: false })
</script>

<style scoped>
.page-head--sticky {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--qj-bg);
  padding-top: var(--sp-1);
}
</style>
