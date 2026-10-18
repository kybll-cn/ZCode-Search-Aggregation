/**
 * 抓取各搜索引擎的真实响应，存到 tests/fixtures/。
 * 解析器必须按真实结构写，不能凭记忆。用法：node tests/capture-fixtures.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, probeProxy, COMMON_PROXY_PORTS } from '../mcp/http.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures');
mkdirSync(FIX, { recursive: true });

const QUERY = process.argv[2] || 'zcode 插件';
const q = encodeURIComponent(QUERY);

const CN_TARGETS = [
  ['baidu', `https://www.baidu.com/s?wd=${q}&rn=20`],
  ['bing', `https://cn.bing.com/search?q=${q}&count=20&setlang=zh-CN`],
  ['so360', `https://www.so.com/s?q=${q}&pn=1`],
  ['sogou', `https://www.sogou.com/web?query=${q}`],
  ['github', `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`],
];
const GLOBAL_TARGETS = [
  ['google', `https://www.google.com/search?q=${q}&num=20&hl=zh-CN`],
  ['yahoo', `https://search.yahoo.com/search?p=${q}&n=20`],
  ['duckduckgo', `https://html.duckduckgo.com/html/?q=${q}`],
];

async function findProxy() {
  for (const port of COMMON_PROXY_PORTS) {
    if (await probeProxy('127.0.0.1', port)) {
      console.log(`[proxy] 127.0.0.1:${port} 可用`);
      return { host: '127.0.0.1', port };
    }
  }
  console.log('[proxy] 未发现可用本地代理，境外引擎将直连');
  return null;
}

const proxy = await findProxy();

async function grab([name, url], useProxy) {
  const t0 = Date.now();
  try {
    const res = await request(url, { proxy: useProxy ? proxy : null, timeout: 15000 });
    writeFileSync(join(FIX, `${name}.raw`), res.body, 'utf8');
    console.log(`${name.padEnd(11)} HTTP=${res.status} ${String(res.body.length).padStart(8)}B ${Date.now() - t0}ms -> fixtures/${name}.raw`);
  } catch (e) {
    console.log(`${name.padEnd(11)} FAIL ${e.message} (${Date.now() - t0}ms)`);
  }
}

console.log(`\n=== 大陆引擎（直连）| query="${QUERY}" ===`);
for (const t of CN_TARGETS) await grab(t, false);
console.log('\n=== 境外引擎（代理） ===');
for (const t of GLOBAL_TARGETS) await grab(t, true);
