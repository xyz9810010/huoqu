<template>
  <span class="qj-badge" :class="'qj-badge--' + tone">
    <span class="qj-badge__dot" aria-hidden="true" />
    <slot>{{ label }}</slot>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  /** 任务/订单状态值，或直接给 tone */
  status?: string
  label?: string
  tone?: 'pending' | 'progress' | 'done' | 'cancel' | 'danger' | 'plain'
}>(), { status: '', label: '', tone: undefined })

const STATUS_TONE: Record<string, 'pending' | 'progress' | 'done' | 'cancel'> = {
  pending: 'pending',
  in_progress: 'progress',
  completed: 'done',
  cancelled: 'cancel',
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待取',
  in_progress: '取件中',
  completed: '已完成',
  cancelled: '已取消',
}

const tone = computed(() => props.tone || STATUS_TONE[props.status] || 'plain')
const label = computed(() => props.label || STATUS_LABEL[props.status] || props.status)
</script>
