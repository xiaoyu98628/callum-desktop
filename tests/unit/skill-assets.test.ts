import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { installSkillAssets } from '../../src/main/backend/skill-assets.ts'
import { resourceRoot } from '../helpers/backend.ts'

test('随附技能安装到隔离数据目录，保留用户技能并拒绝链接目标', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'callum-skills-install-'))
  try {
    await installSkillAssets(resourceRoot, directory)
    const skills = join(directory, 'skills', '.system')
    assert.deepEqual((await readdir(skills)).sort(), [
      'documents',
      'pdf',
      'presentations',
      'spreadsheets',
    ])
    for (const name of await readdir(skills)) {
      const document = await readFile(join(skills, name, 'SKILL.md'))
      assert.ok(document.length <= 64 * 1024, `${name} 必须能被服务技能目录加载`)
    }
    const entry = join(skills, 'documents', 'SKILL.md')
    assert.match(await readFile(entry, 'utf8'), /Callum/)
    await writeFile(entry, 'user edited skill')
    await mkdir(join(directory, 'skills', 'custom'))
    await writeFile(join(directory, 'skills', 'custom', 'SKILL.md'), 'user skill')
    await installSkillAssets(resourceRoot, directory)
    assert.match(await readFile(entry, 'utf8'), /Callum/)
    const copies = await readdir(join(directory, 'skills', '.system-backups'))
    assert.equal(
      await readFile(join(directory, 'skills', '.system-backups', copies[0]!, 'SKILL.md'), 'utf8'),
      'user edited skill',
    )
    assert.equal(
      await readFile(join(directory, 'skills', 'custom', 'SKILL.md'), 'utf8'),
      'user skill',
    )
    assert.ok((await readFile(join(skills, 'documents', 'render_docx.py'))).length > 1000)
    assert.ok(
      (await readFile(join(skills, 'presentations', 'container_tools', 'render_slides.py')))
        .length > 1000,
    )
    if (process.platform !== 'win32') {
      const linked = join(directory, 'linked')
      await mkdir(linked)
      await symlink(skills, join(linked, 'skills'))
      await assert.rejects(installSkillAssets(resourceRoot, linked), /私有普通目录/)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('完整匹配旧随附内容才备份迁移，修改过的平铺技能保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'callum-legacy-skills-'))
  try {
    const resources = join(directory, 'resources')
    await cp(join(resourceRoot, 'skills/.system'), join(resources, 'skills/.system'), {
      recursive: true,
    })
    const profile = join(directory, 'profile')
    await mkdir(profile, { mode: 0o700 })
    const skills = join(profile, 'skills')
    const legacy: Record<string, Record<string, string>> = {}
    for (const name of ['documents', 'pdf']) {
      const content = `# Previous ${name} skill\n`
      await mkdir(join(skills, name), { recursive: true, mode: 0o700 })
      await writeFile(join(skills, name, 'SKILL.md'), content)
      legacy[name] = { 'SKILL.md': createHash('sha256').update(content).digest('hex') }
    }
    await writeFile(join(resources, 'skills/legacy-manifest.json'), JSON.stringify(legacy))
    await writeFile(join(skills, 'pdf/SKILL.md'), 'user modified')
    await installSkillAssets(resources, profile)
    await assert.rejects(readFile(join(skills, 'documents/SKILL.md')), { code: 'ENOENT' })
    assert.equal(await readFile(join(skills, 'pdf/SKILL.md'), 'utf8'), 'user modified')
    const backups = join(skills, '.legacy-backups')
    const [copy, ...otherCopies] = await readdir(backups)
    assert.ok(copy)
    assert.deepEqual(otherCopies, [])
    assert.equal(
      await readFile(join(backups, copy, 'SKILL.md'), 'utf8'),
      '# Previous documents skill\n',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
