<template>
  <!--
    加载失败态。
    为什么需要它：接口失败时，页面原先会直接落到空状态（"暂无客户/暂无取件任务"），
    而后端的错误提示只是一闪而过的 toast。用户看到的是"没有数据"，
    与"服务端出错"无法区分 —— 取件员会误以为今天真的没有单子。
    这里把失败明确画出来，并给一个重试入口。
  -->
  <div class="qj-failed" role="alert">
    <svg class="qj-failed__icon" width="40" height="40" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5" />
      <path d="M12 16.2h.01" />
    </svg>
    <p class="qj-failed__title">{{ title }}</p>
    <p class="qj-failed__desc">{{ message || '请检查网络后重试；若持续失败，请联系管理员。' }}</p>
    <slot>
      <el-button type="primary" :loading="retrying" @click="onRetry">重新加载</el-button>
    </slot>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = withDefaults(defineProps<{
  title?: string
  message?: string
}>(), { title: '加载失败', message: '' })

const emit = defineEmits<{ (e: 'retry'): void }>()
const retrying = ref(false)

async function onRetry() {
  retrying.value = true
  try {
    emit('retry')
    // 交给父级刷新；短暂反馈后复位，避免按钮一直转
    await new Promise((r) => setTimeout(r, 600))
  } finally {
    retrying.value = false
  }
}
</script>
