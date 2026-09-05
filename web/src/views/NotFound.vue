<template>
  <div class="not-found" style="padding:48px 24px;text-align:center">
    <h2 class="page-title">页面不存在</h2>
    <p style="color:#909399;margin:12px 0 24px">地址有误或页面已被移除，请返回首页继续操作。</p>
    <el-button type="primary" @click="router.push('/')">返回首页</el-button>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
const router = useRouter()
</script>
