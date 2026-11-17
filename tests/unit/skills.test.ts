import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatSkillPrefix,
  parseSkillMessage,
  parseSkillReference,
} from '../../src/shared/skills.ts'
import { parseSendInput } from '../../src/shared/chat.ts'

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
  const legacy = `请使用技能 ${JSON.stringify(skill.name)}（入口 ${JSON.stringify(skill.path)}） 完成以下任务：\n任务`
  assert.deepEqual(parseSkillMessage(legacy), { ...skill, body: '任务' })
  assert.equal(formatSkillPrefix(skill), '$Review "2" ')
})

test('相似的普通文本和出现在正文中的引用保持为普通文本', () => {
  for (const text of [
    '请使用技能 pdf 完成以下任务：\n解析一下',
    '请使用技能 "pdf" 完成以下任务：解析一下',
    '请使用技能 "" 完成以下任务：\n解析一下',
    String.raw`请使用技能 "\q" 完成以下任务：` + '\n解析一下',
    '举例：\n请使用技能 "pdf" 完成以下任务：\n解析一下',
  ]) {
    assert.equal(parseSkillMessage(text), null)
  }
})

test('发送参数保留独立技能引用并拒绝额外字段和缺少路径', () => {
  const skill = { name: 'Review', path: '/skills/review/SKILL.md' }
  const input = {
    conversationId: null,
    modelId: '019a4f39-0000-7000-8000-000000000001',
    text: '核对正文',
    skill,
  }
  assert.deepEqual(parseSendInput(input).skill, skill)
  for (const invalid of [
    { name: 'Review' },
    { ...skill, permission: 'allow' },
    { ...skill, path: '' },
  ]) {
    assert.throws(() => parseSkillReference(invalid))
  }
})
