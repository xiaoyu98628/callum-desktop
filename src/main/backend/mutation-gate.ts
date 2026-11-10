/** 同一实体串行写入，应用级管理请求总数有界；失败后始终归还容量。 */
export class MutationGate {
  private readonly mutations = new Set<string>()
  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.mutations.has(key)) throw new Error('此操作正在提交，请稍候。')
    if (this.mutations.size >= 32) throw new Error('正在处理的管理操作过多，请稍后重试。')
    this.mutations.add(key)
    try {
      return await action()
    } finally {
      this.mutations.delete(key)
    }
  }
}
