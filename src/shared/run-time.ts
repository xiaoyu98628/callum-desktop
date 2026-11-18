import { isActiveRun } from './chat.ts'
import type { ChatRun, ChatStep } from './chat.ts'

/** 工具从获准执行时开始计时，审批等待不计入；中断时间不能当作实际结束时间。 */
export function elapsedStepTime(step: ChatStep, now: number): number | null {
  if (step.status === 'interrupted' || step.startedAt === null) return null
  const end = step.status === 'running' ? now : step.finishedAt
  if (
    end === null ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(step.startedAt) ||
    step.startedAt < 0 ||
    end < step.startedAt
  )
    return null
  return end - step.startedAt
}

/** 执行总用时包含等待审批；中断恢复时间不是实际结束时间，不能据此计算耗时。 */
export function elapsedRunTime(run: ChatRun, now: number): number | null {
  if (run.status === 'interrupted') return null
  const end = isActiveRun(run) ? now : run.finishedAt
  if (
    end === null ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(run.createdAt) ||
    run.createdAt < 0 ||
    end < run.createdAt
  )
    return null
  return end - run.createdAt
}

export function formatRunTime(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error('执行用时无效')
  if (milliseconds < 1000) return '不到 1 秒'
  const seconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    remaining = seconds % 60
  const parts: string[] = []
  if (hours) parts.push(`${hours} 小时`)
  if (minutes) parts.push(`${minutes} 分`)
  if (remaining) parts.push(`${remaining} 秒`)
  return parts.join(' ')
}
