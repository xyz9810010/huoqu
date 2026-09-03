<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="brand">
        <div class="logo"><el-icon :size="30"><Van /></el-icon></div>
        <h1>Huoqu</h1>
        <p>Pickup Operations Management</p>
      </div>

      <el-form :model="form" @submit.prevent>
        <el-form-item>
          <el-input v-model="form.username" placeholder="用户名" class="big-input" :prefix-icon="User" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" placeholder="密码" class="big-input"
                    :prefix-icon="Lock" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" class="login-btn" :loading="loading" @click="submit">
          登 录
        </el-button>
      </el-form>

      <div class="hint">请使用管理员分配的账号登录</div>
    </div>
    <div class="footer">客服派单 · 取件员移动录单 · 老板经营看板</div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()
const loading = ref(false)
const form = reactive({ username: '', password: '' })

async function submit() {
  if (!form.username || !form.password) {
    ElMessage.warning('请输入用户名和密码')
    return
  }
  loading.value = true
  try {
    await auth.login(form.username, form.password)
    ElMessage.success('登录成功')
    const roleHome: Record<string, string> = { boss: '/dashboard', admin: '/dashboard', cs: '/tasks', worker: '/worker/tasks' }
    router.push(roleHome[auth.role] || '/')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrap {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--qj-bg);
}
.login-card {
  width: 480px;
  background: #fff;
  border: 1px solid var(--qj-border);
  border-radius: 14px;
  padding: 48px 44px 36px;
  box-shadow: 0 4px 20px rgba(31, 35, 41, 0.06);
}
.brand {
  text-align: center;
  margin-bottom: 36px;
}
.logo {
  width: 68px;
  height: 68px;
  margin: 0 auto 18px;
  border-radius: 16px;
  background: var(--el-color-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.brand h1 {
  font-size: 24px;
  font-weight: 600;
  margin: 0 0 8px;
  color: var(--qj-text);
  letter-spacing: 1px;
}
.brand p {
  margin: 0;
  font-size: 14px;
  color: var(--qj-muted);
  letter-spacing: 1px;
}
.big-input :deep(.el-input__wrapper) {
  height: 48px;
  border-radius: 8px;
}
.big-input :deep(.el-input__inner) {
  font-size: 15px;
}
.login-btn {
  width: 100%;
  height: 48px;
  font-size: 16px;
  letter-spacing: 6px;
  border-radius: 8px;
  margin-top: 8px;
}
.hint {
  margin-top: 28px;
  padding-top: 18px;
  border-top: 1px solid var(--qj-border);
  font-size: 13px;
  color: var(--qj-muted);
}
.footer {
  position: absolute;
  bottom: 24px;
  color: var(--qj-muted);
  font-size: 13px;
}
</style>
