/**
 * 逐引擎真实查询测试：验证解析器能从真实页面提出结果。
 * 用法：node tests/test-engines.mjs [查询词]
 */
import { ENGINES, runEngine } from '../mcp/engines.mjs';
import { request, probeProxy, COMMON_PROXY_PORTS } from '../mcp/http.mjs';

const QUERY = process.argv[2] || 'zcode 插件';
const LIMIT = 5;

async function findProxy() {
  for (const port of COMMON_PROXY_PORTS) {
    if (await probeProxy('127.0.0.1', port)) return { host: '127.0.0.1', port };
  }
  return null;
}

const proxy = await findProxy();
console.log(`查询="${QUERY}" 每引擎取 ${LIMIT} 条 | 代理=${proxy ? `${proxy.host}:${proxy.port}` : '无'}\n`);

const ctx = {
  limit: LIMIT,
  proxy,
  fetch: (url, opts = {}) => request(url, { proxy, timeout: 20000, ...opts }),
};

const ids = Object.keys(ENGINES);
let pass = 0;
const report = [];

for (const id of ids) {
  const engine = ENGINES[id];
  const out = await runEngine(engine, QUERY, ctx);
  const tag = out.status === 'ok' ? '✅' : out.status === 'empty' ? '⚠️ ' : '❌';
  console.log(`${tag} ${engine.label.padEnd(12)} status=${out.status.padEnd(6)} n=${String(out.results.length).padStart(2)} ${String(out.tookMs).padStart(5)}ms${out.error ? ` err=${out.error}` : ''}`);
  if (out.results.length) {
    pass += 1;
    for (const r of out.results.slice(0, 3)) {
      console.log(`      · ${r.title.slice(0, 60)}`);
      console.log(`        ${r.url.slice(0, 100)}`);
    }
    report.push({ id, ok: true, n: out.results.length });
  } else {
    report.push({ id, ok: false, n: 0, error: out.error || 'no results' });
  }
  console.log('');
}

console.log(`\n===== 汇总: ${pass}/${ids.length} 个引擎成功返回结果 =====`);
for (const r of report) if (!r.ok) console.log(`  未通过: ${r.id} — ${r.error}`);
process.exit(pass === ids.length ? 0 : 1);
