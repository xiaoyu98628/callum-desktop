import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  APPLICATION_URL,
  isTrustedRendererUrl,
  resolveRendererAsset,
  resolveRendererUrl,
} from '../../src/main/security/renderer-policy.ts'

describe('界面来源策略', () => {
  it('发布环境使用固定的本地应用地址', () => {
    assert.equal(resolveRendererUrl(), APPLICATION_URL)
  })

  it('开发环境仅接受本机 HTTP 服务', () => {
    assert.equal(resolveRendererUrl('http://127.0.0.1:5173'), 'http://127.0.0.1:5173/')
    for (const url of [
      'https://example.com',
      'http://127.0.0.1.example.com:5173',
      'file:///tmp/index.html',
      'http://user:secret@localhost:5173',
      'http://localhost:5173/?url=external',
    ]) {
      assert.throws(() => resolveRendererUrl(url), '应拒绝非预期的开发地址')
    }
  })

  it('校验自定义协议的主机，避免 null origin 被误判为同源', () => {
    assert.equal(isTrustedRendererUrl('callum://app/#appearance', APPLICATION_URL), true)
    for (const url of [
      'callum://other/',
      'file:///tmp/index.html',
      'about:blank',
      'callum://app/assets/app.js',
      'callum://user@app/',
      'not-a-url',
    ]) {
      assert.equal(isTrustedRendererUrl(url, APPLICATION_URL), false, url)
    }
  })

  it('开发 IPC 不接受其他端口或页面', () => {
    const trusted = 'http://127.0.0.1:5173/'
    assert.equal(isTrustedRendererUrl(trusted, trusted), true)
    assert.equal(isTrustedRendererUrl('http://127.0.0.1:5174/', trusted), false)
    assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/other.html', trusted), false)
  })
})

describe('发布资源路径边界', () => {
  const root = resolve('/tmp/callum-renderer')

  it('只映射应用目录下的入口与资源', () => {
    assert.equal(resolveRendererAsset(root, 'callum://app/'), resolve(root, 'index.html'))
    assert.equal(
      resolveRendererAsset(root, 'callum://app/assets/app.js?v=1'),
      resolve(root, 'assets/app.js'),
    )
  })

  it('拒绝其他协议、主机、端口和凭据', () => {
    for (const url of [
      'file:///etc/passwd',
      'https://app/',
      'callum://other/',
      'callum://app:80/',
      'callum://user:secret@app/',
    ]) {
      assert.equal(resolveRendererAsset(root, url), null, url)
    }
  })

  it('拒绝编码后的路径逃逸、反斜杠、空字节和损坏编码', () => {
    for (const path of [
      '/%2e%2e%2fsecret.txt',
      '/%2f..%2fsecret.txt',
      '/%5c..%5csecret.txt',
      '/assets/%00.js',
      '/%ZZ',
    ]) {
      assert.equal(resolveRendererAsset(root, `callum://app${path}`), null, path)
    }
  })
})
