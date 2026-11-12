import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RpcClient, RpcConnectionError } from '../../src/main/backend/rpc-client.ts'

const ready = `const ready={jsonrpc:'2.0',method:'system.ready',params:{service:'callum',protocol_version:1,max_request_bytes:1048576,max_response_bytes:8388608}};`
function client(
  script: string,
  notify: (method: string, params: unknown) => void = () => undefined,
  disconnected: () => void = () => undefined,
) {
  return new RpcClient(process.execPath, ['-e', ready + script], notify, disconnected)
}

test('stdio 按行组帧，支持 UTF-8 分片及并发响应关联', async () => {
  const events: unknown[] = []
  const rpc = client(
    `
    const rl=require('node:readline').createInterface({input:process.stdin});
    const b=Buffer.from(JSON.stringify(ready)+'\\n'+JSON.stringify({jsonrpc:'2.0',method:'fixture',params:{text:'中文🙂'}})+'\\n');
    let done;const output=new Promise(resolve=>done=resolve);
    let i=0;const timer=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i>=b.length){clearInterval(timer);done()}},1);
    rl.on('line',line=>{const r=JSON.parse(line);output.then(()=>{if(r.method==='system.shutdown'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:true})+'\\n',()=>process.exit(0));return}setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.params})+'\\n'),r.params.delay)})});
  `,
    (_method, params) => events.push(params),
  )
  try {
    assert.deepEqual(
      await Promise.all([
        rpc.request('fixture', { delay: 60, value: 'a' }),
        rpc.request('fixture', { delay: 1, value: 'b' }),
      ]),
      [
        { delay: 60, value: 'a' },
        { delay: 1, value: 'b' },
      ],
    )
    assert.deepEqual(events, [{ text: '中文🙂' }])
  } finally {
    await rpc.close()
  }
})

for (const [name, action] of [
  ['损坏 JSON', `process.stdout.write('bad\\n')`],
  ['超过帧限制', `process.stdout.write(Buffer.alloc(8388609,65))`],
  ['中断的帧', `process.stdout.write('{');process.exit(0)`],
] as const) {
  test(`stdio 拒绝${name}并使待处理请求失败`, async () => {
    let disconnected = 0
    const rpc = client(
      `process.stdout.write(JSON.stringify(ready)+'\\n');process.stdin.once('data',()=>{${action}})`,
      () => undefined,
      () => disconnected++,
    )
    try {
      await assert.rejects(rpc.request('fixture', {}))
      assert.equal(disconnected, 1)
    } finally {
      await rpc.close()
    }
  })
}

test('请求超时不自动重试，并有界关闭无响应子进程', async () => {
  const rpc = client(`process.stdout.write(JSON.stringify(ready)+'\\n');process.stdin.resume()`)
  try {
    await assert.rejects(rpc.request('fixture', {}, 80), /受理结果未知/)
  } finally {
    await rpc.close()
    await rpc.close()
  }
})

test('启动失败会释放连接，不遗留待处理请求', async () => {
  const rpc = new RpcClient(
    '/not-existing/callum',
    [],
    () => undefined,
    () => undefined,
  )
  await assert.rejects(rpc.ready)
  await rpc.close()
})

for (const [name, diagnostic, expected] of [
  [
    '已知实例锁原因',
    JSON.stringify({
      level: 'ERROR',
      module: 'main',
      error: '该数据目录已有运行中的 Callum 服务\nsecret-private-path',
    }),
    /已有运行中的 Callum 服务/,
  ],
  [
    '未知内部错误',
    JSON.stringify({ level: 'ERROR', module: 'main', error: 'secret-key-and-private-path' }),
    /在就绪前退出/,
  ],
  [
    '内置解释器损坏',
    JSON.stringify({
      level: 'ERROR',
      module: 'main',
      error: '加载内置运行时: secret-private-path',
    }),
    /内置 Python\/Node\/Git 资源校验失败/,
  ],
  [
    '诊断容量边界',
    'x'.repeat(16 * 1024) +
      '\n' +
      JSON.stringify({
        level: 'ERROR',
        module: 'main',
        error: '该数据目录已有运行中的 Callum 服务',
      }),
    /在就绪前退出/,
  ],
] as const) {
  test(`启动失败识别${name}，不泄露原始诊断`, async () => {
    const rpc = client(
      `process.stderr.write(${JSON.stringify(diagnostic + '\n')}, () => process.exit(1))`,
    )
    try {
      await assert.rejects(rpc.ready, (error: unknown) => {
        assert.ok(error instanceof RpcConnectionError)
        assert.match(error.message, expected)
        assert.doesNotMatch(error.message, /secret|private-path/)
        return true
      })
    } finally {
      await rpc.close()
    }
  })
}

test('启动握手失败保留安全的协议原因', async () => {
  const rpc = client(
    `process.stdout.write(JSON.stringify({...ready, params: {...ready.params, protocol_version: 999}})+'\\n');process.stdin.resume()`,
  )
  try {
    await assert.rejects(rpc.ready, /启动握手失败/)
  } finally {
    await rpc.close()
  }
})

test('启动超时结束等待并释放子进程', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const rpc = client('process.stdin.resume()')
  try {
    const rejected = assert.rejects(rpc.ready, /启动超时/)
    t.mock.timers.tick(15_000)
    await rejected
  } finally {
    await rpc.close()
  }
})
