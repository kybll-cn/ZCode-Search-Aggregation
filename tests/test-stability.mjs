/**
 * 稳定性测试：多个查询词逐一跑全部引擎，统计成功率。
 * 目的是确认解析不是"偶尔对一次"，而是换关键词也稳。
 * 用法：node tests/test-stability.mjs
 */
import { ENGINES, runEngine } from '../mcp/engines.mjs';
import { request, probeProxy, COMMON_PROXY_PORTS } from '../mcp/http.mjs';

const QUERIES = ['python 异步编程', 'React 19 新特性', 'zcode 插件'];
const LIMIT = 5;

async function findProxy() {
  for (const port of COMMON_PROXY_PORTS) {
    if (await probeProxy('127.0.0.1', port)) return { host: '127.0.0.1', port };
  }
  return null;
}

const proxy = await findProxy();
const ids = Object.keys(ENGINES);
const tally = Object.fromEntries(ids.map((id) => [id, { ok: 0, fail: 0, reasons: [] }]));

for (const query of QUERIES) {
  console.log(`\n===== 查询：${query} =====`);
  const ctx = {
    limit: LIMIT,
    proxy,
    fetch: (url, opts = {}) => request(url, { proxy, timeout: 20000, ...opts }),
  };

  const outcomes = await Promise.all(ids.map((id) => runEngine(ENGINES[id], query, ctx)));

  for (const o of outcomes) {
    const hit = tally[o.id];
    const mark = o.status === 'ok' ? '✅' : '❌';
    if (o.status === 'ok') hit.ok += 1;
    else { hit.fail += 1; hit.reasons.push(o.error || o.status); }
    const first = o.results[0]?.title?.slice(0, 42) || '';
    console.log(`  ${mark} ${o.label.padEnd(11)} n=${String(o.results.length).padStart(2)} ${String(o.tookMs).padStart(5)}ms  ${first}`);
  }
}

console.log('\n===== 稳定性汇总 =====');
let allOk = true;
for (const id of ids) {
  const t = tally[id];
  const rate = `${t.ok}/${t.ok + t.fail}`;
  const flag = t.fail === 0 ? '✅' : '⚠️ ';
  if (t.fail) allOk = false;
  console.log(`  ${flag} ${ENGINES[id].label.padEnd(12)} ${rate}${t.fail ? `  失败原因: ${[...new Set(t.reasons)].join(' | ')}` : ''}`);
}
process.exit(allOk ? 0 : 1);
