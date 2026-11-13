import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import { resolveRuntimeDirectory } from '../../src/main/backend/runtime-assets.ts'
import { array, record } from '../../src/shared/chat.ts'
import type { ChatEvent } from '../../src/shared/chat.ts'
import { resourceRoot, seedModel, supportedBackend } from '../helpers/backend.ts'

const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64'
const execute = promisify(execFile)

async function toolkit() {
  const root = resolveRuntimeDirectory(resourceRoot)
  const manifest = record(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')))
  const workspace = record(manifest.workspace)
  const bin = join(root, String(workspace.bin_directory))
  const native =
    process.platform === 'win32'
      ? record(JSON.parse(await readFile(join(bin, 'native-executables.json'), 'utf8')))
      : { pdftoppm: 'pdftoppm' }
  return {
    python: join(root, String(record(manifest.python).path)),
    node: join(root, String(record(manifest.node).path)),
    modules: join(root, String(workspace.node_modules)),
    bin,
    pdftoppm: join(bin, String(native.pdftoppm)),
  }
}

test(
  '本地 Word 与 PDF 生成、编辑和渲染，Apple Silicon 同时验证 Excel 与 PowerPoint',
  { skip: !supportedBackend, timeout: 60_000 },
  async (t) => {
    const paths = await toolkit()
    const work = await mkdtemp(join(tmpdir(), 'callum-office-formats-'))
    t.after(() => rm(work, { recursive: true, force: true }))
    const env = {
      ...process.env,
      PATH: [paths.bin, process.env.PATH].filter(Boolean).join(delimiter),
      RUNTIME_NODE: paths.node,
      RUNTIME_PYTHON: paths.python,
      RUNTIME_NODE_MODULES: paths.modules,
      RUNTIME_BIN_DIR: paths.bin,
      CALLUM_RUN_WORK_DIR: work,
      TMPDIR: work,
      TEMP: work,
      TMP: work,
      PYTHONDONTWRITEBYTECODE: '1',
    }
    await execute(
      paths.python,
      [
        '-I',
        '-B',
        '-c',
        `
from pathlib import Path
from docx import Document
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
import numpy
import sys
p=Path(sys.argv[1]); d=Document(); d.add_paragraph('Original content'); d.save(p/'report.docx')
d=Document(p/'report.docx'); d.paragraphs[0].text='Edited document content'; d.save(p/'report.docx')
c=canvas.Canvas(str(p/'source.pdf')); c.drawString(72,720,'Local PDF content'); c.save()
r=PdfReader(p/'source.pdf'); w=PdfWriter(); w.append(r); w.add_metadata({'/Title':'Edited PDF'}); w.write(p/'report.pdf')
assert 'Local PDF content' in PdfReader(p/'report.pdf').pages[0].extract_text()
assert numpy.arange(3).sum() == 3
`,
        work,
      ],
      { env, timeout: 20_000, maxBuffer: 1024 * 1024 },
    )
    if (appleSilicon) {
      const helper = pathToFileURL(
        join(resourceRoot, 'skills/.system/presentations/container_tools/runtime_helpers.mjs'),
      ).href
      const builder = join(work, 'build.mjs')
      await writeFile(
        builder,
        `
import fs from 'node:fs/promises';
import { importRuntimeModule } from ${JSON.stringify(helper)};
const { Workbook, SpreadsheetFile, Presentation, PresentationFile, FileBlob } = await importRuntimeModule('@oai/artifact-tool');
const w=Workbook.create(); const s=w.worksheets.add('Data'); s.getRange('A1:B1').values=[[2,3]]; s.getRange('C1').formulas=[['=SUM(A1:B1)']]; w.recalculate();
await (await SpreadsheetFile.exportXlsx(w)).save('source.xlsx');
const edited=await SpreadsheetFile.importXlsx(await FileBlob.load('source.xlsx')); const e=edited.worksheets.getItemAt(0); e.getRange('A1').values=[[4]]; edited.recalculate();
if(e.getRange('C1').values[0][0]!==7) throw new Error('recalculation failed');
await (await SpreadsheetFile.exportXlsx(edited)).save('report.xlsx');
const preview=await edited.render({sheetName:'Data',autoCrop:'all',scale:1,format:'png'}); await fs.writeFile('sheet.png',new Uint8Array(await preview.arrayBuffer()));
const p=Presentation.create({slideSize:{width:1280,height:720}}); const slide=p.slides.add();
const title=slide.shapes.add({geometry:'textbox',position:{left:72,top:80,width:1000,height:100},fill:'none',line:{fill:'none',width:0}}); title.text='Original title'; title.text.style={fontSize:40,color:'#172033',fontFamily:'Arial'};
await (await PresentationFile.exportPptx(p)).save('source.pptx');
const deck=await PresentationFile.importPptx(await FileBlob.load('source.pptx')); deck.slides.items[0].shapes.items[0].text='Edited presentation title';
await (await PresentationFile.exportPptx(deck)).save('report.pptx');
`,
      )
      await execute(paths.node, [builder], {
        cwd: work,
        env,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      })
      await execute(
        paths.python,
        [
          '-I',
          '-B',
          join(resourceRoot, 'skills/.system/presentations/container_tools/render_slides.py'),
          join(work, 'report.pptx'),
          '--output_dir',
          join(work, 'slide-pages'),
        ],
        { env, timeout: 25_000, maxBuffer: 2 * 1024 * 1024 },
      )
      assert.ok((await readdir(join(work, 'slide-pages'))).some((name) => name.endsWith('.png')))
    }
    await execute(
      paths.python,
      [
        '-I',
        '-B',
        join(resourceRoot, 'skills/.system/documents/render_docx.py'),
        join(work, 'report.docx'),
        '--output_dir',
        join(work, 'document-pages'),
        '--width',
        '800',
      ],
      { env, timeout: 25_000, maxBuffer: 1024 * 1024 },
    )
    await execute(
      paths.pdftoppm,
      ['-png', '-scale-to', '800', join(work, 'report.pdf'), join(work, 'pdf-page')],
      { env, timeout: 20_000, maxBuffer: 1024 * 1024 },
    )
    await execute(
      paths.python,
      [
        '-I',
        '-B',
        '-c',
        `
from pathlib import Path
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation
from PIL import Image
import sys
p=Path(sys.argv[1]); assert Document(p/'report.docx').paragraphs[0].text=='Edited document content'
images = [*(p/'document-pages').glob('*.png'), *p.glob('pdf-page*.png')]
if sys.argv[2] == 'true':
    w=load_workbook(p/'report.xlsx',data_only=True); assert w.active['C1'].value==7; w.close()
    assert Presentation(p/'report.pptx').slides[0].shapes[0].text=='Edited presentation title'
    images.extend([p/'sheet.png', *(p/'slide-pages').glob('*.png')])
for png in images:
    with Image.open(png) as image: assert image.width>0 and image.height>0
`,
        work,
        String(appleSilicon),
      ],
      { env, timeout: 20_000, maxBuffer: 1024 * 1024 },
    )
    assert.ok((await readdir(join(work, 'document-pages'))).some((name) => name.endsWith('.png')))
    assert.ok((await readdir(work)).some((name) => /^pdf-page.*\.png$/.test(name)))
  },
)

test(
  'Agent 读取技能、运行原有渲染脚本、接收视觉输入并交付稳定文件副本',
  { skip: !appleSilicon, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-office-agent-'))
    const builder = join(profile, 'builder.py')
    await writeFile(
      builder,
      `from pathlib import Path\nfrom docx import Document\nimport os,sys\np=Path(sys.argv[1]); d=Document(); d.add_paragraph('Agent generated document'); d.save(p/'report.docx'); (p/'data.bin').write_bytes(os.urandom(2*1024*1024+13)); (p/'empty.txt').write_bytes(b'')\n`,
    )
    let number = 0
    let work = ''
    let python = ''
    let imageSeen = false
    const errors: unknown[] = []
    const upstream = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = record(JSON.parse(Buffer.concat(chunks).toString()))
        const messages = array(input.messages, record)
        const auxiliary = !Array.isArray(input.tools) || input.tools.length === 0
        let message: Record<string, unknown> = { role: 'assistant', content: 'Files are ready.' }
        if (!auxiliary) {
          assert.ok(JSON.stringify(messages).includes('Codex SKILL.md'))
          for (const skill of ['documents', 'spreadsheets', 'presentations', 'pdf']) {
            assert.ok(JSON.stringify(messages).includes(`skills/.system/${skill}/SKILL.md`))
          }
          const last = messages.findLast((row) => row.role === 'tool')
          const result = last ? record(JSON.parse(String(last.content))) : null
          if (result?.error) throw new Error(JSON.stringify(result))
          let name = '',
            args: unknown = {}
          switch (number++) {
            case 0:
              name = 'read_file'
              args = {
                path: join(profile, 'backend/skills/.system/documents/SKILL.md'),
                end_line: 70,
              }
              break
            case 1:
              name = 'load_workspace_dependencies'
              break
            case 2: {
              const runtime = record(result?.result)
              work = String(runtime.work_directory)
              python = String(runtime.python)
              name = 'run_command'
              args = { command: [python, builder, work], cwd: work }
              break
            }
            case 3:
              assert.equal(record(result?.result).exit_code, 0, JSON.stringify(result))
              name = 'run_command'
              args = {
                command: [
                  python,
                  join(profile, 'backend/skills/.system/documents/render_docx.py'),
                  join(work, 'report.docx'),
                  '--output_dir',
                  join(work, 'pages'),
                  '--width',
                  '600',
                ],
                cwd: work,
              }
              break
            case 4:
              assert.equal(record(result?.result).exit_code, 0, JSON.stringify(result))
              name = 'view_image'
              args = { path: join(work, 'pages/page-1.png') }
              break
            case 5:
              imageSeen = messages.some(
                (row) =>
                  Array.isArray(row.content) &&
                  row.content.some(
                    (part: unknown) =>
                      record(part).type === 'image_url' &&
                      String(record(record(part).image_url).url).startsWith(
                        'data:image/png;base64,',
                      ),
                  ),
              )
              assert.ok(imageSeen, '页面图片应直接进入下一次模型推理')
              name = 'publish_artifact'
              args = { path: join(work, 'report.docx') }
              break
            case 6:
              name = 'publish_artifact'
              args = { path: join(work, 'data.bin') }
              break
            case 7:
              name = 'publish_artifact'
              args = { path: join(work, 'empty.txt') }
              break
          }
          if (name)
            message = {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  ...(input.stream === true ? { index: 0 } : {}),
                  id: `office-${number}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            }
        }
        const reason = message.tool_calls ? 'tool_calls' : 'stop'
        response.setHeader('Content-Type', input.stream ? 'text/event-stream' : 'application/json')
        response.end(
          input.stream
            ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`
            : JSON.stringify({ choices: [{ index: 0, message, finish_reason: reason }] }),
        )
      })().catch((error) => {
        errors.push(error)
        response.writeHead(500).end()
      })
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    assert.ok(address && typeof address !== 'string')
    let service: ChatService | undefined
    try {
      const modelId = await seedModel(
        profile,
        `http://127.0.0.1:${address.port}/v1`,
        'on-request',
        true,
      )
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const events: ChatEvent[] = []
      service.subscribe((event) => events.push(event))
      const accepted = await service.send({
        conversationId: null,
        modelId,
        text: 'Create an Office document',
      })
      const deadline = Date.now() + 35_000
      for (;;) {
        const terminal = events.findLast(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === accepted.runId &&
            ['completed', 'failed', 'cancelled'].includes(event.change.value.status),
        )
        if (terminal?.change.kind === 'run') {
          assert.equal(
            terminal.change.value.status,
            'completed',
            JSON.stringify({ terminal, errors: errors.map(String) }),
          )
          break
        }
        assert.ok(
          Date.now() < deadline,
          JSON.stringify({ events: events.slice(-5), errors: errors.map(String) }),
        )
        await setTimeout(20)
      }
      assert.ok(imageSeen)
      assert.equal(number, 9)
      await assert.rejects(stat(work), { code: 'ENOENT' })
      const detail = await service.detail(accepted.conversationId)
      const answer = detail.messages.findLast((message) => message.role === 'assistant')
      assert.ok(answer)
      const files = answer.content.flatMap((block, index) =>
        block.type === 'file' ? [{ block, index }] : [],
      )
      assert.deepEqual(
        files.map((file) => file.block.name),
        ['report.docx', 'data.bin', 'empty.txt'],
      )
      for (const file of files) {
        const saved = await service.readAttachmentFile({
          conversationId: accepted.conversationId,
          messageId: answer.id,
          index: file.index,
        })
        assert.equal(saved.name, file.block.name)
        assert.equal(saved.bytes.length, file.block.size ?? 0)
      }
      assert.deepEqual(errors, [])
    } finally {
      await service?.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      await rm(profile, { recursive: true, force: true })
    }
  },
)
