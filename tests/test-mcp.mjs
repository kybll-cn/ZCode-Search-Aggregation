/**
 * MCP 协议端到端测试：真的把 server 当子进程启动，用 JSON-RPC 对话。
 * 用法：node tests/test-mcp.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'mcp', 'server.mjs');

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const pending = new Map();
const stderrLines = [];

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('!! 非法 JSON 输出:', line.slice(0, 120));
      continue;
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  }
});

child.stderr.on('data', (d) => stderrLines.push(d.toString().trim()));

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时（60s）`)), 60000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  // 1. 握手
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-harness', version: '1.0.0' },
  });
  check('initialize 返回 serverInfo', !!init.result?.serverInfo?.name, init.result?.serverInfo?.name);
  check('协议版本回显', init.result?.protocolVersion === '2025-06-18', init.result?.protocolVersion);
  notify('notifications/initialized');

  // 2. 工具列表
  const list = await rpc('tools/list', {});
  const tools = list.result?.tools || [];
  check('tools/list 返回 2 个工具', tools.length === 2, tools.map((t) => t.name).join(', '));
  const searchTool = tools.find((t) => t.name === 'web_search');
  check('web_search 有 query 必填参数', !!searchTool?.inputSchema?.required?.includes('query'));
  check('web_search 的 engines 枚举含 8 个引擎', searchTool?.inputSchema?.properties?.engines?.items?.enum?.length === 8);

  // 3. 未知（比自身更新）的协议版本要回退到自身最新版，而不是照抄或报错。
  //    ZCode 客户端协商的是 2026-07-28，官方 MCP SDK 的处理方式与此相同：
  //    SUPPORTED.includes(requested) ? requested : LATEST
  const unknownVersion = await rpc('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
    clientInfo: { name: 'zcode', version: '0.16.9' },
  });
  check(
    '未知协议版本回退到自身最新版',
    unknownVersion.result?.protocolVersion === '2025-06-18',
    unknownVersion.result?.protocolVersion
  );

  // 4. 引擎状态（不探测，只读缓存）
  const engines = await rpc('tools/call', { name: 'search_engines', arguments: {} });
  const engText = engines.result?.content?.[0]?.text || '';
  check('search_engines 返回文本', engText.includes('搜索引擎状态'), `${engText.length} 字符`);

  // 4. 真实聚合搜索
  const search = await rpc('tools/call', {
    name: 'web_search',
    arguments: { query: 'zcode 插件', limit: 3 },
  });
  const text = search.result?.content?.[0]?.text || '';
  const payload = search.result?.structuredContent;
  check('web_search 返回文本结果', text.length > 100, `${text.length} 字符`);
  check('structuredContent 结构完整', !!payload?.engines && Array.isArray(payload?.results));
  const okEngines = (payload?.engines || []).map((e) => e.id);
  check('至少 5 个引擎返回结果', okEngines.length >= 5, okEngines.join(', '));
  check('结果 URL 都是 http(s)', (payload?.results || []).every((g) => g.results.every((r) => /^https?:\/\//.test(r.url))));
  check('结果无跨引擎重复 URL', (() => {
    const all = (payload?.results || []).flatMap((g) => g.results.map((r) => r.url));
    return new Set(all).size === all.length;
  })());

  // 5. 指定引擎 + 交错模式
  const inter = await rpc('tools/call', {
    name: 'web_search',
    arguments: { query: 'react 19', engines: ['bing', 'baidu'], limit: 2, mode: 'interleave', force: true },
  });
  const interPayload = inter.result?.structuredContent;
  check('指定引擎生效', (interPayload?.engines || []).every((e) => ['bing', 'baidu'].includes(e.id)),
    (interPayload?.engines || []).map((e) => e.id).join(', '));
  check('interleave 返回扁平列表', Array.isArray(interPayload?.results) && interPayload.results.every((r) => r.engine),
    `${interPayload?.results?.length || 0} 条`);

  // 6. 错误处理
  const bad = await rpc('tools/call', { name: 'web_search', arguments: { query: '' } });
  check('空 query 返回 isError', bad.result?.isError === true);

  const unknown = await rpc('tools/call', { name: '不存在工具', arguments: {} });
  check('未知工具返回 JSON-RPC 错误', !!unknown.error, unknown.error?.message);

  console.log('\n--- server 日志 ---');
  console.log(stderrLines.join('\n') || '(空)');
} catch (e) {
  check('测试异常', false, e.message);
} finally {
  child.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 项通过 =====`);
process.exit(failed.length ? 1 : 0);
