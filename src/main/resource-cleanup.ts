/** 清理失败与原始操作错误同时保留，调用方负责界面边界的安全错误转换。 */
export async function withCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<unknown>,
): Promise<T> {
  let result: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    result = { ok: true, value: await operation() }
  } catch (error) {
    result = { ok: false, error }
  }
  let cleanupFailure: { error: unknown } | undefined
  try {
    await cleanup()
  } catch (error) {
    cleanupFailure = { error }
  }
  if (cleanupFailure) {
    if (!result.ok)
      throw new AggregateError([result.error, cleanupFailure.error], '操作与资源清理均失败', {
        cause: result.error,
      })
    throw cleanupFailure.error
  }
  if (!result.ok) throw result.error
  return result.value
}
