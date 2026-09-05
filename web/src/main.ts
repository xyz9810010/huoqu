import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'element-plus/dist/index.css'
import './styles/theme.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router'
import { notificationSound } from './services/notification-sound'

notificationSound.install()
const app = createApp(App)
app.use(createPinia())
app.use(router)
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component as any)
}
app.mount('#app')
