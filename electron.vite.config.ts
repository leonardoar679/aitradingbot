import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          // The price forecast's training, in a worker thread of its own (electron/forecast/trainWorker.ts):
          // built beside index.js as forecastWorker.js, which forecastWorkerService.ts starts.
          forecastWorker: resolve(__dirname, 'electron/forecast/trainWorker.ts'),
          // The tasks that read strangers' text or heavy records (V8 Stage 1; shared/tasks.ts), each in a worker
          // thread of its own with a memory limit and a deadline: built as taskWorker.js, started by
          // taskWorkerService.ts.
          taskWorker: resolve(__dirname, 'electron/tasks/taskWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared')
      }
    },
    plugins: [react()]
  }
})
