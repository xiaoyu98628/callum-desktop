import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseAppInfo } from '../../src/shared/desktop-api.ts'

describe('桌面通信契约', () => {
  it('接受有效信息并仅返回契约中的字段', () => {
    assert.deepEqual(
      parseAppInfo({
        name: 'Callum',
        version: '0.1.0',
        platform: 'darwin',
        privatePath: '/private',
      }),
      {
        name: 'Callum',
        version: '0.1.0',
        platform: 'darwin',
      },
    )
  })

  it('拒绝缺失、损坏及不支持的平台信息', () => {
    for (const value of [
      null,
      undefined,
      [],
      'Callum',
      {},
      { name: 'Callum', version: 1, platform: 'darwin' },
      { name: '', version: '0.1.0', platform: 'linux' },
      { name: 'Callum', version: '0.1.0', platform: 'unknown' },
    ]) {
      assert.throws(() => parseAppInfo(value))
    }
  })
})
