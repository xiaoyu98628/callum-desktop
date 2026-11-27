/** 有界同步订阅；失败只撤销对应消费者，不能把回调错误传播到共享传输。 */
export class Subscriptions<T> {
  private readonly listeners = new Set<(value: T) => void>()
  private closed = false
  private readonly report: () => void
  constructor(
    report: () => void = () =>
      console.error(
        JSON.stringify({ level: 'warn', module: 'subscriptions', message: '已撤销失败的事件订阅' }),
      ),
  ) {
    this.report = report
  }
  add(listener: (value: T) => void): () => void {
    if (this.closed) return () => {}
    if (this.listeners.size >= 32) throw new Error('事件订阅数量超出限制')
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  emit(value: T): void {
    if (this.closed) return
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue
      try {
        listener(value)
      } catch {
        this.listeners.delete(listener)
        // 诊断出口自身失败也不能污染连接；不记录消费者异常原文。
        try {
          this.report()
        } catch {
          /* 主运行时不依赖诊断消费者。 */
        }
      }
    }
  }
  close(): void {
    this.closed = true
    this.listeners.clear()
  }
}
