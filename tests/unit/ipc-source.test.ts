import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTrustedIpcSource } from '../../src/main/security/ipc-source.ts'

test('共用 IPC 来源规则只接受存活主窗口的可信主 frame', () => {
  const frame = { url: 'callum://app/' }
  const contents = { mainFrame: frame, isDestroyed: () => false }
  const window = { webContents: contents, isDestroyed: () => false }
  const event = { sender: contents, senderFrame: frame }
  assert.equal(isTrustedIpcSource(event, window, 'callum://app/'), true)
  assert.equal(
    isTrustedIpcSource({ ...event, senderFrame: { ...frame } }, window, 'callum://app/'),
    false,
  )
  assert.equal(isTrustedIpcSource({ ...event, senderFrame: null }, window, 'callum://app/'), false)
  assert.equal(isTrustedIpcSource({ ...event, sender: {} }, window, 'callum://app/'), false)
  assert.equal(isTrustedIpcSource(event, null, 'callum://app/'), false)
  assert.equal(
    isTrustedIpcSource(event, { ...window, isDestroyed: () => true }, 'callum://app/'),
    false,
  )
  contents.isDestroyed = () => true
  assert.equal(isTrustedIpcSource(event, window, 'callum://app/'), false)
  contents.isDestroyed = () => false
  for (const url of [
    'https://example.invalid/',
    'callum://other/',
    'callum://app/other',
    'callum://app/?key=1',
    'callum://user@app/',
  ]) {
    frame.url = url
    assert.equal(isTrustedIpcSource(event, window, 'callum://app/'), false)
  }
})
