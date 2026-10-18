#!/usr/bin/env node
/**
 * ZCode 搜索聚合 MCP 服务（stdio）。
 *
 * 零依赖：只用 node: 内置模块，插件装完即可运行，不需要 npm install。
 * stdout 只承载 JSON-RPC 消息，所有日志走 stderr。
 */

import readline from 'node:readline';
import { Aggregator } from './aggregator.mjs';
import { ENGINES, runEngine } from './engines.mjs';
import { COMMON_PROXY_PORTS } from './http.mjs';

const SERVER_NAME = 'search-aggregation';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function log(...args) {
  process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);
}

/* ------------------------------ 运行时配置 ------------------------------ */

/**
 * 读一个字符串型环境变量，把"未替换的 ${...} 占位符"和空白一律当未设置。
 * 宿主没注入 user_config 时，env 里可能留着占位符字面量，
 * 若直接当代理地址用会导致所有请求都走一个不存在的代理。
 */
function envString(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw || raw.includes('${')) return fallback;
  return raw;
}

const config = {
  proxy: envString('SEARCH_PROXY', 'auto'),
  timeout: Number(envString('SEARCH_TIMEOUT', '')) || 15000,
  ttl: Number(envString('SEARCH_TTL', '')) || 5 * 60 * 1000,
  cacheTtl: Number(envString('SEARCH_CACHE_TTL', '')) || 60 * 1000,
};

const aggregator = new Aggregator(config);

/** 相同查询短时间内的结果复用，同时减轻 GitHub API 的限速压力。 */
const resultCache = new Map(); // key -> { payload, at }

function cacheKey(query, options) {
  return JSON.stringify([query, options.limit, options.mode, options.engines, options.force]);
}

function readCache(key) {
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > config.cacheTtl) {
    resultCache.delete(key);
    return null;
  }
  return hit.payload;
}

function writeCache(key, payload) {
  if (resultCache.size > 100) resultCache.clear();
  resultCache.set(key, { payload, at: Date.now() });
}

/* -------------------------------- 工具定义 -------------------------------- */

const ENGINE_IDS = Object.keys(ENGINES);
const CN_IDS = ENGINE_IDS.filter((id) => ENGINES[id].region === 'cn');
const GLOBAL_IDS = ENGINE_IDS.filter((id) => ENGINES[id].region === 'global');

const TOOLS = [
  {
    name: 'web_search',
    title: '并行聚合搜索',
    description:
      '同时向多个搜索引擎发起查询并汇总结果，用于需要多来源、多视角信息的检索。\n' +
      `大陆引擎（可直连）：${CN_IDS.map((id) => ENGINES[id].label).join('、')}；` +
      `境外引擎（需代理）：${GLOBAL_IDS.map((id) => ENGINES[id].label).join('、')}。\n` +
      '默认只跑当前可达的引擎：境外引擎一旦因网络不可达就会被自动跳过，此时等价于只用大陆搜索。\n' +
      '跨引擎重复的 URL 会自动去重。Google 走的是新闻 RSS 检索，结果是新闻条目而非网页。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，支持中文与英文。' },
        engines: {
          type: 'array',
          items: { type: 'string', enum: ENGINE_IDS },
          description: `指定要用的引擎（默认自动选择可达的）。可选：${ENGINE_IDS.join(', ')}。`,
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: '每个引擎返回的结果条数，默认 5。',
        },
        mode: {
          type: 'string',
          enum: ['group', 'interleave'],
          description: 'group=按引擎分组展示（默认，便于对比各来源）；interleave=各引擎结果交错混排成一个列表。',
        },
        force: {
          type: 'boolean',
          description: '忽略"近期不可达"的缓存，强制重试全部引擎（网络恢复后用）。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_engines',
    title: '查看搜索引擎状态',
    description:
      '列出可用的搜索引擎及其当前可达状态、所在区域。probe=true 时实际发一次探测请求刷新状态，' +
      '用于确认外网/代理是否可用。只读，不改变任何配置。',
    inputSchema: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: '是否实际发送探测请求刷新可达性（默认 false，仅读缓存）。' },
      },
      additionalProperties: false,
    },
  },
];

/* ------------------------------ 结果格式化 ------------------------------ */

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatSearchResult(res) {
  const lines = [];
  const total = res.results.reduce
    ? (res.mode === 'interleave'
        ? res.results.length
        : res.results.reduce((n, g) => n + g.results.length, 0))
    : 0;

  lines.push(`# 搜索：${res.query}`);
  lines.push(
    `引擎 ${res.engines.length} 个 · 结果 ${total} 条 · 耗时 ${(res.tookMs / 1000).toFixed(1)}s` +
    `${res.proxy ? ` · 代理 ${res.proxy}` : ' · 直连'}` +
    `${res.duplicates ? ` · 去重 ${res.duplicates} 条` : ''}`
  );
  lines.push('');

  if (res.mode === 'interleave') {
    res.results.forEach((r, i) => {
      lines.push(`${i + 1}. [${r.title}](${r.url})  — \`${r.engineLabel}\``);
      if (r.snippet) lines.push(`   ${truncate(r.snippet, 200)}`);
    });
  } else {
    for (const g of res.results) {
      lines.push(`## ${g.label}（${g.results.length} 条 · ${(g.tookMs / 1000).toFixed(1)}s）`);
      g.results.forEach((r, i) => {
        lines.push(`${i + 1}. [${r.title}](${r.url})`);
        if (r.snippet) lines.push(`   ${truncate(r.snippet, 200)}`);
      });
      if (g.note) lines.push(`   ⚠️ ${g.note}`);
      lines.push('');
    }
  }

  if (res.skipped.length) {
    lines.push(
      `> 已跳过（近期不可达或本次无结果）：${res.skipped.map((s) => `${s.label}${s.reason ? `（${s.reason}）` : ''}`).join('、')}`
    );
    lines.push('> 网络恢复后可用 force=true 强制重试。');
  }
  if (res.errors.length) {
    lines.push(`> 本次出错：${res.errors.map((e) => `${e.label}：${e.error}`).join('；')}`);
  }
  if (!res.results.length) {
    lines.push('（没有任何引擎返回结果，可能是关键词过窄、网络受限或被站点风控拦截。）');
  }
  return lines.join('\n');
}

function formatEngineList(entries, probed) {
  const lines = [`# 搜索引擎状态${probed ? '（已实时探测）' : '（读取缓存）'}`];
  const cn = entries.filter((e) => e.region === 'cn');
  const global = entries.filter((e) => e.region === 'global');
  const render = (list, title) => {
    lines.push('', `## ${title}`);
    for (const e of list) {
      const state = e.status === 'ok' ? '✅ 可用' : e.status === 'error' ? `❌ ${e.error}` : '❔ 未知（尚未探测）';
      lines.push(`- **${e.label}** (\`${e.id}\`)：${state}`);
    }
  };
  render(cn, '大陆引擎（直连）');
  render(global, '境外引擎（需要代理）');
  lines.push('', `代理设置：\`${config.proxy}\``);
  return lines.join('\n');
}

/* -------------------------------- 工具执行 -------------------------------- */

async function callWebSearch(args) {
  const query = String(args?.query || '').trim();
  if (!query) throw new Error('query 不能为空');

  const options = {
    engines: Array.isArray(args.engines) && args.engines.length ? args.engines : null,
    limit: args.limit ? Number(args.limit) : 5,
    mode: args.mode === 'interleave' ? 'interleave' : 'group',
    force: !!args.force,
  };

  const key = cacheKey(query, options);
  let payload = readCache(key);
  let cached = false;
  if (payload) {
    cached = true;
  } else {
    payload = await aggregator.search(query, options);
    writeCache(key, payload);
  }

  const text = formatSearchResult(payload) + (cached ? '\n\n> 结果来自 60 秒内的缓存。' : '');
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  };
}

async function callEngineList(args) {
  const probe = !!args?.probe;
  const ids = Object.keys(ENGINES);

  const entries = await Promise.all(
    ids.map(async (id) => {
      const engine = ENGINES[id];
      const base = { id, label: engine.label, region: engine.region, status: 'unknown', error: null };

      if (!probe) {
        const known = aggregator.health.get(id);
        if (!known) return base;
        if (known.usable) return { ...base, status: 'ok' };
        if (Date.now() - known.checkedAt > config.ttl) return base;
        return { ...base, status: 'error', error: known.reason || '不可达' };
      }

      // 实时探测：发一次真实查询，只看是否拿到可解析结果。
      const proxy = engine.region === 'global' ? await aggregator.resolveProxy() : null;
      try {
        const out = await runProbe(engine, proxy);
        aggregator.markHealth(id, out.ok, out.reason);
        return out.ok
          ? { ...base, status: 'ok' }
          : { ...base, status: 'error', error: out.reason };
      } catch (e) {
        const reason = e.message || '探测失败';
        aggregator.markHealth(id, false, reason);
        return { ...base, status: 'error', error: reason };
      }
    })
  );

  return {
    content: [{ type: 'text', text: formatEngineList(entries, probe) }],
    structuredContent: { engines: entries, proxy: aggregator.proxyCache?.proxy || null, proxySetting: config.proxy },
  };
}

async function runProbe(engine, proxy) {
  const ctx = { ...aggregator.makeContext(proxy), limit: 2 };
  const out = await runEngine(engine, 'test', ctx);
  if (out.status === 'ok') return { ok: true };
  if (out.status === 'empty') return { ok: true, reason: 'HTTP 正常但无解析结果（可能被风控）' };
  return { ok: false, reason: out.error || '不可达' };
}

/* ------------------------------- JSON-RPC ------------------------------- */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const version = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          '多引擎并行搜索。默认自动选择当前可达的引擎：若外网不可达，会自动跳过 Google/Yahoo/DuckDuckGo 等境外引擎，只用百度、必应、360、搜狗等大陆引擎。',
      });
      return;
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // 通知不需要响应

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        if (name === 'web_search') return reply(id, await callWebSearch(args));
        if (name === 'search_engines') return reply(id, await callEngineList(args));
        return replyError(id, -32602, `未知工具：${name}`);
      } catch (e) {
        return reply(id, {
          content: [{ type: 'text', text: `搜索失败：${e.message}` }],
          isError: true,
        });
      }
    }

    case 'resources/list':
      reply(id, { resources: [] });
      return;

    case 'prompts/list':
      reply(id, { prompts: [] });
      return;

    default:
      if (id !== undefined) replyError(id, -32601, `不支持的方法：${method}`);
  }
}

function main() {
  log(`启动，协议版本 ${SUPPORTED_PROTOCOLS[0]}，node ${process.version}`);
  log(`代理设置=${config.proxy}，本地代理候选端口=${COMMON_PROXY_PORTS.join(',')}`);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      log('忽略非法 JSON 行');
      return;
    }
    handleMessage(msg).catch((e) => {
      log(`处理消息出错：${e.stack || e.message}`);
      if (msg && msg.id !== undefined) replyError(msg.id, -32603, e.message);
    });
  });

  rl.on('close', () => {
    log('stdin 关闭，退出');
    process.exit(0);
  });

  process.on('uncaughtException', (e) => log(`未捕获异常：${e.stack || e.message}`));
  process.on('unhandledRejection', (e) => log(`未处理的 Promise 拒绝：${e}`));
}

main();
