<template>
  <header class="page-head" :class="{ 'page-head--sticky': sticky, 'page-head--nowrap': nowrap }">
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
  /** 窄屏也保持标题与操作同一行（用于操作不多、纵向空间紧张的页面） */
  nowrap?: boolean
}>(), { description: '', sticky: false, nowrap: false })
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
