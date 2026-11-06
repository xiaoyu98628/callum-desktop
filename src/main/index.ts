import { app, dialog } from 'electron'
import { startApplication } from './application'

void startApplication().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      module: 'bootstrap',
      message: '应用启动失败',
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  dialog.showErrorBox('Callum 无法启动', '应用初始化失败，请检查启动日志后重试。')
  process.exitCode = 1
  app.quit()
})
