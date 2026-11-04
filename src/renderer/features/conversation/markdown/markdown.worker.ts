import { renderMarkdown } from './render'
import { validateTexts } from './contract'
import type { MarkdownReply } from './contract'

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data
  if (
    typeof request !== 'object' ||
    request === null ||
    !('id' in request) ||
    !('revision' in request) ||
    !('texts' in request) ||
    typeof request.id !== 'number' ||
    !Number.isSafeInteger(request.id) ||
    typeof request.revision !== 'number' ||
    !Number.isSafeInteger(request.revision)
  )
    return
  let reply: MarkdownReply
  try {
    reply = {
      id: request.id,
      revision: request.revision,
      document: renderMarkdown(validateTexts(request.texts)),
    }
  } catch {
    reply = { id: request.id, revision: request.revision, error: '消息排版失败，已按文本显示。' }
  }
  self.postMessage(reply)
})
