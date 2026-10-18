/**
 * 聚合调度：并行跑各引擎、自动发现代理、缓存可用性。
 *
 * "外网不通就只用大陆搜索"是这样落地的：
 * 可达性结果带 TTL 缓存，境外引擎一旦因网络原因失败就被标记为不可用并跳过，
 * 后续查询只跑大陆引擎，不重复付出超时代价；TTL 到期后会再试一次。
 */

import { ENGINES, runEngine } from './engines.mjs';
import { request, probeProxy, COMMON_PROXY_PORTS } from './http.mjs';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * 临时性失败（网络不通、被限流、服务端 5xx）——这类失败值得缓存并稍后重试。
 * 与"站点改版导致解析为空"区分开：后者不该被当成不可达。
 */
function isTransientError(message = '') {
  return /timeout|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|proxy|connect|network|aborted|验证码|限流|安全验证|空壳|HTTP 5\d\d/i.test(
    message
  );
}

/**
 * 反爬拦截（验证码/安全验证）比普通网络故障需要更长冷却期：
 * 5 分钟就回去重试只会继续触发风控，反而拖长封禁时间。
 */
function isRateLimit(message = '') {
  return /验证码|限流|安全验证/.test(message);
}

/** URL 归一化，用于跨引擎去重。 */
export function normalizeUrl(raw = '') {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_src$|spm$|from$|src$|sca_esv|ei$|ved$|usg$)/i.test(key)) u.searchParams.delete(key);
    }
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return String(raw).toLowerCase();
  }
}

export class Aggregator {
  /**
   * @param {object} config
   * @param {'auto'|'off'|string} config.proxy   auto=自动发现本地代理；off=只直连；其他值当作代理地址
   * @param {number} config.timeout              单引擎超时（毫秒）
   * @param {number} config.ttl                  可达性缓存时长（毫秒）
   */
  constructor(config = {}) {
    this.proxySetting = (config.proxy || 'auto').trim();
    this.timeout = config.timeout || 15000;
    this.ttl = config.ttl || DEFAULT_TTL_MS;
    /** 被反爬拦截时的冷却期，比普通网络故障长。 */
    this.rateLimitTtl = config.rateLimitTtl || 15 * 60 * 1000;

    /** @type {{proxy: object|null, resolvedAt: number}|null} */
    this.proxyCache = null;
    /** @type {Map<string, {usable: boolean, reason?: string, checkedAt: number}>} */
    this.health = new Map();
  }

  /* ----------------------------- 代理处理 ----------------------------- */

  async resolveProxy() {
    if (this.proxySetting === 'off') return null;

    const fresh = this.proxyCache && Date.now() - this.proxyCache.resolvedAt < this.ttl;
    if (fresh) return this.proxyCache.proxy;

    let proxy = null;
    if (this.proxySetting === 'auto') {
      // 并发探活，避免串行等待 9 个端口。
      const hits = await Promise.all(
        COMMON_PROXY_PORTS.map(async (port) => ((await probeProxy('127.0.0.1', port)) ? port : null))
      );
      const port = hits.find(Boolean);
      if (port) proxy = { host: '127.0.0.1', port };
    } else if (/^https?:\/\//i.test(this.proxySetting)) {
      const u = new URL(this.proxySetting);
      const auth = u.username
        ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`
        : null;
      proxy = { host: u.hostname, port: parseInt(u.port || '80', 10), auth };
    }

    this.proxyCache = { proxy, resolvedAt: Date.now() };
    return proxy;
  }

  /* ---------------------------- 引擎上下文 ---------------------------- */

  makeContext(proxy) {
    return {
      limit: 5,
      proxy,
      fetch: (url, opts = {}) =>
        request(url, {
          proxy,
          timeout: this.timeout,
          ...opts,
        }),
    };
  }

  /** 这个引擎当前是否值得跑。 */
  isUsable(engineId, { force = false } = {}) {
    if (force) return true;
    const h = this.health.get(engineId);
    if (!h) return true;
    if (Date.now() - h.checkedAt > (h.ttl || this.ttl)) return true; // 缓存过期，再试一次
    return h.usable;
  }

  markHealth(engineId, usable, reason) {
    this.health.set(engineId, {
      usable,
      reason,
      checkedAt: Date.now(),
      ttl: usable ? this.ttl : (isRateLimit(reason) ? this.rateLimitTtl : this.ttl),
    });
  }

  /** 供工具展示：当前已知的引擎状态。 */
  healthSnapshot() {
    return [...this.health.entries()].map(([id, h]) => ({
      id,
      label: ENGINES[id]?.label || id,
      usable: h.usable,
      reason: h.reason,
      checkedAt: new Date(h.checkedAt).toISOString(),
      stale: Date.now() - h.checkedAt > (h.ttl || this.ttl),
    }));
  }

  /* ------------------------------ 主搜索 ------------------------------ */

  /**
   * @param {string} query
   * @param {object} options
   * @param {string[]} [options.engines]  指定引擎 id；不传=自动选可用的
   * @param {number}   [options.limit]    每引擎结果数
   * @param {'group'|'interleave'} [options.mode]
   * @param {boolean}  [options.force]    忽略不可用缓存，强制重试全部
   */
  async search(query, options = {}) {
    const started = Date.now();
    const limit = Math.max(1, Math.min(options.limit || 5, 20));
    const mode = options.mode === 'interleave' ? 'interleave' : 'group';
    const force = !!options.force;

    const explicit = Array.isArray(options.engines) && options.engines.length
      ? options.engines.map((e) => String(e).toLowerCase())
      : null;

    const unknown = explicit ? explicit.filter((id) => !ENGINES[id]) : [];
    const requested = explicit ? explicit.filter((id) => ENGINES[id]) : Object.keys(ENGINES);

    const runnable = [];
    const skipped = [];
    for (const id of requested) {
      if (this.isUsable(id, { force })) runnable.push(id);
      else skipped.push({ id, label: ENGINES[id].label, reason: this.health.get(id)?.reason || '近期不可达' });
    }

    const needsProxy = runnable.some((id) => ENGINES[id].region === 'global');
    const proxy = needsProxy ? await this.resolveProxy() : null;

    const outcomes = await Promise.all(
      runnable.map((id) => runEngine(ENGINES[id], query, { ...this.makeContext(proxy), limit }))
    );

    // 临时性失败 -> 记成不可用；解析为空但 HTTP 正常 -> 站点结构变了，不能怪网络。
    for (const o of outcomes) {
      if (o.status === 'error' && isTransientError(o.error)) {
        this.markHealth(o.id, false, o.error.includes('proxy') ? '代理不可用' : o.error);
      } else {
        this.markHealth(o.id, true);
      }
    }
    // 这一轮如果所有境外引擎都失败，顺手确认代理是否还活着，避免继续用一个死掉的端口。
    if (proxy && outcomes.some((o) => o.region === 'global' && o.status === 'error')) {
      const alive = await probeProxy(proxy.host, proxy.port);
      if (!alive) this.proxyCache = null;
    }

    const groups = outcomes.filter((o) => o.results.length);
    const empty = outcomes.filter((o) => o.status === 'empty').map((o) => ({ id: o.id, label: o.label }));
    const errors = outcomes.filter((o) => o.status === 'error').map((o) => ({ id: o.id, label: o.label, error: o.error }));

    const deduped = dedupeAcrossEngines(groups);

    return {
      query,
      mode,
      tookMs: Date.now() - started,
      proxy: proxy ? `${proxy.host}:${proxy.port}` : null,
      engines: deduped.groups.map((g) => ({
        id: g.id,
        label: g.label,
        region: g.region,
        count: g.results.length,
        tookMs: g.tookMs,
        note: g.note,
      })),
      results: mode === 'interleave' ? interleave(deduped.groups) : deduped.groups,
      duplicates: deduped.duplicates,
      skipped: [...skipped, ...empty],
      errors: [...errors, ...(unknown.length ? [{ id: unknown.join(','), error: '未知引擎名' }] : [])],
    };
  }
}

/** 同一 URL 只归首个命中的引擎，后续引擎里去掉并计数。 */
function dedupeAcrossEngines(groups) {
  const seen = new Map(); // normalizedUrl -> engineId
  let duplicates = 0;
  const out = groups.map((g) => {
    const kept = [];
    for (const r of g.results) {
      const key = normalizeUrl(r.url);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.set(key, g.id);
      kept.push(r);
    }
    return { ...g, results: kept };
  }).filter((g) => g.results.length);
  return { groups: out, duplicates };
}

/** 各引擎轮流取一条，混成单一列表。 */
function interleave(groups) {
  const out = [];
  const max = Math.max(0, ...groups.map((g) => g.results.length));
  for (let i = 0; i < max; i += 1) {
    for (const g of groups) {
      if (g.results[i]) out.push({ ...g.results[i], engine: g.id, engineLabel: g.label, rank: i + 1 });
    }
  }
  return out;
}
