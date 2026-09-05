<template>
  <el-config-provider :locale="zhCn">
    <router-view />
  </el-config-provider>
</template>

<script setup lang="ts">
// @ts-ignore element-plus 的 locale 文件未附带类型声明
import zhCn from 'element-plus/es/locale/lang/zh-cn'
</script>

<style>
html, body, #app {
  height: 100%;
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: #f5f6f8;
}
</style>
