import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSkillPrefix, parseSkillMessage } from '../../src/shared/skills.ts'

test('从已保存的技能引用提取原名和正文并保留原有空白', () => {
  const body = '  解析一下\n\n保留段落。'
  assert.deepEqual(parseSkillMessage(`请使用技能 "Presentations" 完成以下任务：\n${body}`), {
    name: 'Presentations',
    body,
  })
  assert.deepEqual(parseSkillMessage('请使用技能 "pdf" 完成以下任务：'), {
    name: 'pdf',
    body: '',
  })
})

test('同名技能引用中的引号和 Windows 路径可还原', () => {
  const skill = { name: 'Review "2"', path: 'C:\\skills\\review-v2\\SKILL.md' }
  assert.deepEqual(parseSkillMessage(`${formatSkillPrefix(skill)}任务`), { ...skill, body: '任务' })
})

test('相似的普通文本和出现在正文中的引用保持为普通文本', () => {
  for (const text of [
    '请使用技能 pdf 完成以下任务：\n解析一下',
    '请使用技能 "pdf" 完成以下任务：解析一下',
    '请使用技能 "" 完成以下任务：\n解析一下',
    String.raw`请使用技能 "\q" 完成以下任务：` + '\n解析一下',
    `举例：\n${formatSkillPrefix({ name: 'pdf' })}解析一下`,
  ]) {
    assert.equal(parseSkillMessage(text), null)
  }
})
