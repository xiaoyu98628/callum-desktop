import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseAppInfo, parseServiceState } from '../../src/shared/desktop-api.ts'

describe('桌面通信契约', () => {
  it('服务状态只接受已知生命周期，并保留失败原因', () => {
    for (const status of ['starting', 'ready', 'closing'])
      assert.deepEqual(parseServiceState({ status, privatePath: '/private' }), { status })
    assert.deepEqual(parseServiceState({ status: 'failed', error: '无法启动服务' }), {
      status: 'failed',
      error: '无法启动服务',
    })
    assert.deepEqual(parseServiceState({ status: 'startup-failed', error: '服务程序缺失' }), {
      status: 'startup-failed',
      error: '服务程序缺失',
    })
    for (const value of [
      null,
      {},
      'ready',
      { status: 'unknown' },
      { status: 'failed' },
      { status: 'failed', error: '' },
      { status: 'failed', error: 1 },
      { status: 'failed', error: 'x'.repeat(4097) },
      { status: 'startup-failed' },
      { status: 'startup-failed', error: '' },
    ])
      assert.throws(() => parseServiceState(value))
  })

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
