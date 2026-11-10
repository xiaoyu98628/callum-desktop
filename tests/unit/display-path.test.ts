import assert from 'node:assert/strict'
import { test } from 'node:test'
import { abbreviateHomePath } from '../../src/shared/display-path.ts'

test('路径仅缩写真实用户目录及后代，保留其他用户和相邻目录', () => {
  assert.equal(abbreviateHomePath('/Users/alice', '/Users/alice'), '~')
  assert.equal(abbreviateHomePath('/Users/alice/www/project', '/Users/alice/'), '~/www/project')
  assert.equal(
    abbreviateHomePath('/Users/alice-other/project', '/Users/alice'),
    '/Users/alice-other/project',
  )
  assert.equal(abbreviateHomePath('/Users/bob/project', '/Users/alice'), '/Users/bob/project')
  assert.equal(abbreviateHomePath('/home/alice/project', '/home/alice'), '~/project')
  assert.equal(abbreviateHomePath('/tmp/project', ''), '/tmp/project')
  assert.equal(abbreviateHomePath('/project', '/'), '~/project')
})

test('Windows 用户目录按路径边界匹配，并统一缩写部分的分隔符', () => {
  assert.equal(abbreviateHomePath('C:\\Users\\Alice\\project', 'c:\\users\\alice'), '~/project')
  assert.equal(abbreviateHomePath('C:/Users/Alice/project', 'C:\\Users\\Alice\\'), '~/project')
  assert.equal(
    abbreviateHomePath('C:\\Users\\Alice2\\project', 'C:\\Users\\Alice'),
    'C:\\Users\\Alice2\\project',
  )
  assert.equal(
    abbreviateHomePath('\\\\server\\home\\Alice\\project', '\\\\server\\home\\Alice'),
    '~/project',
  )
})
