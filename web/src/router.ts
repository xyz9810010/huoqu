import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'

const roleHome: Record<string, string> = {
  boss: '/dashboard',
  admin: '/dashboard',
  cs: '/tasks',
  worker: '/worker/tasks',
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/Login.vue') },
    {
      path: '/',
      component: () => import('./views/Layout.vue'),
      children: [
        { path: '', redirect: () => roleHome[useAuthStore().role] || '/login' },
        { path: 'dashboard', component: () => import('./views/Dashboard.vue'), meta: { roles: ['boss', 'admin'] } },
        { path: 'customers', component: () => import('./views/Customers.vue'), meta: { roles: ['cs', 'admin', 'boss'] } },
        { path: 'customers/:id', component: () => import('./views/CustomerDetail.vue'), meta: { roles: ['cs', 'admin', 'boss'] } },
        { path: 'dispatch', component: () => import('./views/Dispatch.vue'), meta: { roles: ['cs', 'admin'] } },
        { path: 'tasks', component: () => import('./views/Tasks.vue'), meta: { roles: ['cs', 'admin', 'boss'] } },
        { path: 'tasks/:id', component: () => import('./views/TaskDetail.vue') },
        { path: 'match-center', component: () => import('./views/MatchCenter.vue'), meta: { roles: ['cs', 'admin'] } },
        { path: 'worker/tasks', component: () => import('./views/WorkerTasks.vue'), meta: { roles: ['worker'] } },
        { path: 'my-data', component: () => import('./views/MyData.vue'), meta: { roles: ['worker'] } },
        { path: 'areas', component: () => import('./views/Areas.vue'), meta: { roles: ['admin'] } },
        { path: 'employees', component: () => import('./views/Employees.vue'), meta: { roles: ['admin'] } },
        { path: 'logs', component: () => import('./views/Logs.vue'), meta: { roles: ['admin'] } },
        { path: 'notifications', component: () => import('./views/Notifications.vue'), meta: { title: '通知中心' } },
        { path: 'notification-settings', component: () => import('./views/NotificationSettings.vue'), meta: { title: '消息设置' } },
        { path: 'push-providers', component: () => import('./views/PushProviders.vue'), meta: { roles: ['admin'], title: '消息推送' } },
        { path: ':pathMatch(.*)*', component: () => import('./views/NotFound.vue') },
      ],
    },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (to.path !== '/login' && !auth.isLoggedIn) {
    return '/login'
  }
  if (to.path === '/login' && auth.isLoggedIn) {
    return roleHome[auth.role] || '/'
  }
  const roles = to.meta.roles as string[] | undefined
  if (roles && !roles.includes(auth.role)) {
    return roleHome[auth.role] || '/login'
  }
  return true
})

export default router
