import { inject, onScopeDispose, provide } from 'vue'
import type { InjectionKey } from 'vue'
import { MarkdownRenderer } from './renderer'

const key: InjectionKey<MarkdownRenderer> = Symbol('markdown-renderer')
export function provideMarkdownRenderer(): void {
  const renderer = new MarkdownRenderer()
  provide(key, renderer)
  onScopeDispose(() => renderer.close())
}
export function useMarkdownRenderer(): MarkdownRenderer {
  const renderer = inject(key)
  if (!renderer) throw new Error('消息排版上下文未初始化')
  return renderer
}
