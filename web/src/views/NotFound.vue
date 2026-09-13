<template>
  <div class="not-found">
    <PageHead title="页面不存在" />
    <EmptyState title="地址有误或页面已被移除" description="请返回首页继续操作">
      <el-button type="primary" @click="router.push('/')">返回首页</el-button>
    </EmptyState>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import PageHead from '../components/PageHead.vue'
import EmptyState from '../components/EmptyState.vue'

const router = useRouter()
</script>

<style scoped>
.not-found {
  max-width: 480px;
  margin: var(--sp-8) auto 0;
}
</style>
