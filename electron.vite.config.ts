import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import { DEVELOPMENT_CSP } from './src/main/security/content-security-policy.ts'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ command }) => ({
  main: {
    build: {
      lib: {
        entry: resolve(root, 'src/main/index.ts'),
        formats: ['es'],
        fileName: () => 'index.js',
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      lib: {
        entry: resolve(root, 'src/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(root, 'src/renderer'),
        '@shared': resolve(root, 'src/shared'),
      },
    },
    plugins: [
      vue(),
      tailwindcss(),
      {
        name: 'callum-development-csp',
        transformIndexHtml(html) {
          // 发布页面的 CSP 由自定义协议的响应头设置，开发服务器单独允许 HMR。
          return command === 'serve'
            ? html.replace(
                '<!-- development-csp -->',
                `<meta http-equiv="Content-Security-Policy" content="${DEVELOPMENT_CSP}">`,
              )
            : html
        },
      },
    ],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
  },
}))
