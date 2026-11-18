import type { FollowUpMode } from './follow-up.ts'
import { integer, record } from './validation.ts'

export interface GeneralSettings {
  revision: number
  followUpMode: FollowUpMode
}

export function parseGeneralSettings(value: unknown): GeneralSettings {
  const input = record(value)
  if (
    Object.keys(input).some((key) => key !== 'revision' && key !== 'followUpMode') ||
    (input.followUpMode !== 'queue' && input.followUpMode !== 'steer')
  )
    throw new Error('常规设置无效')
  return { revision: integer(input.revision, 1), followUpMode: input.followUpMode }
}

export function generalSettingsFromRpc(value: unknown): GeneralSettings {
  const input = record(value)
  if (input.key !== 'general') throw new Error('常规设置归属无效')
  return parseGeneralSettings({
    revision: input.revision,
    followUpMode: record(input.value).follow_up_mode,
  })
}
