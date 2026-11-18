import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveRuntimeDirectory } from '../../src/main/backend/runtime-assets.ts'
import { resourceRoot } from './backend.ts'

/** 用真实内置解释器创建独立 Office 样本，只写调用方提供的测试目录。 */
export async function createOfficeFixtures(directory: string): Promise<string[]> {
  const runtime = resolveRuntimeDirectory(resourceRoot)
  const python = join(
    runtime,
    'python',
    ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']),
  )
  await promisify(execFile)(
    python,
    [
      '-I',
      '-B',
      '-c',
      `
from pathlib import Path
import sys
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
p=Path(sys.argv[1])
d=Document(); d.add_paragraph('quarterly-plan-42'); d.save(p/'plan.docx')
w=Workbook(); w.active['A1']='income-42'; w.save(p/'income.xlsx'); w.close()
r=Presentation(); s=r.slides.add_slide(r.slide_layouts[1]); s.shapes.title.text='review-42'; r.save(p/'review.pptx')
`,
      directory,
    ],
    { timeout: 20000, cwd: directory, windowsHide: true },
  )
  return ['plan.docx', 'income.xlsx', 'review.pptx'].map((name) => join(directory, name))
}
