import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [
    vue(),
    Components({
      // 样式统一走 main.ts 的 element-plus/dist/index.css，避免逐组件注入重复样式
      resolvers: [ElementPlusResolver({ importStyle: false })],
      dts: 'src/components.d.ts'
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3000',
        ws: true,
      },
    },
  },
})
