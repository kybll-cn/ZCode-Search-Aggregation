/**
 * 各搜索引擎的抓取与解析实现。
 *
 * 解析规则全部依据 tests/fixtures/ 下抓到的真实响应写成，不是凭记忆写的正则。
 * 每个引擎独立失败互不影响，返回统一结构：{ title, url, snippet, engine }。
 */

/* ------------------------------- 文本工具 ------------------------------- */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  '#39': "'", '#34': '"', '#38': '&', '#60': '<', '#62': '>',
};

export function decodeEntities(text = '') {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z#0-9]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

function safeCodePoint(code) {
  try {
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  } catch {
    return '';
  }
}

/** 去标签 + 解实体 + 压空白，用于标题/摘要这种纯文本字段。 */
export function plainText(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** 只去掉标签，保留实体解码顺序正确（href 里常见 &amp;）。 */
export function cleanUrl(url = '') {
  return decodeEntities(String(url).trim());
}

/* ------------------------------ 页面抓取 ------------------------------ */

const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Sec-CH-UA': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * 一段 HTML 按某个标记切成块，块序即结果序。
 * 用切分而不是配对标签，避免正则无法处理嵌套 div 的问题。
 */
function splitBlocks(html, markerRegex) {
  return html.split(markerRegex).slice(1);
}

/**
 * 按 RSS/Atom 的 <item> 提取字段。
 * Bing 和 Google 新闻都走这条路：结构稳定，且 link 就是真实地址。
 */
function parseRssItems(body, { mapTitle } = {}) {
  const out = [];
  for (const m of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const r = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    const rawTitle = pick('title');
    const link = pick('link');
    if (!rawTitle || !link) continue;
    const { title, snippet } = mapTitle
      ? mapTitle(rawTitle, pick)
      : { title: plainText(rawTitle), snippet: plainText(decodeEntities(pick('description'))) };
    if (!title) continue;
    out.push({ title, url: decodeEntities(link), snippet: snippet.slice(0, 300) });
  }
  return out;
}

/* ------------------------------- 引擎定义 ------------------------------- */

/**
 * 每个引擎：
 *  - region  : cn = 大陆可直连；global = 通常需要代理
 *  - build   : (query, limit) => { url, method?, headers?, body? }
 *  - parse   : (body, ctx) => results[]
 *  - 可选 search(query, ctx)：需要多步流程的引擎自己实现（Yahoo 的 cookie 挑战）
 *  - 可选 prepare(body)：返回给下一跳用的 cookie（配合 build 再次调用）
 */
export const ENGINES = {
  baidu: {
    id: 'baidu',
    label: '百度',
    region: 'cn',
    home: 'https://www.baidu.com',
    build: (q, limit) => ({ url: `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${Math.min(limit + 10, 50)}&ie=utf-8` }),
    detectBlock: (body) =>
      /百度安全验证|wappass\.baidu\.com|网络不给力/.test(body) ? '触发百度安全验证，需稍后重试' : null,
    parse: (body) => {
      const out = [];
      for (const block of splitBlocks(body, /<div[^>]*class="result(?:-op)? c-container[^"]*"/)) {
        // 真实 URL 在容器的 mu 属性上；跳转链接（/link?url=）不带域名信息，不可用。
        const mu = (block.match(/\bmu="([^"]+)"/) || [])[1];
        const href = (block.match(/<h3[^>]*>[\s\S]{0,400}?<a[^>]*href="([^"]+)"/) || [])[1];
        const titleHtml = (block.match(/<h3[^>]*>[\s\S]{0,400}?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1];
        const snippetHtml =
          (block.match(/class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/span>/) || [])[1] ||
          (block.match(/class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/) || [])[1] ||
          (block.match(/<span class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/span>/) || [])[1];

        const url = pickBaiduUrl(mu, href);
        const title = plainText(titleHtml);
        if (!url || !title) continue;
        out.push({ title, url, snippet: plainText(snippetHtml).slice(0, 300) });
      }
      return out;
    },
  },

  bing: {
    id: 'bing',
    label: '必应',
    region: 'cn',
    home: 'https://www.bing.com',
    // 必须用 www.bing.com：cn.bing.com 在本机实测会返回与查询无关的降级页
    // （查 "zcode 插件" 却给出车牌号、儿歌之类），www 才返回正确结果。
    // format=rss 是官方输出的结构化通道，比抓 HTML 稳定得多。
    build: (q, limit) => ({
      url: `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=${Math.min(limit + 5, 20)}`,
    }),
    parse: (body) => {
      if (!/<item>/.test(body)) return [];
      return parseRssItems(body);
    },
  },

  so360: {
    id: 'so360',
    label: '360搜索',
    region: 'cn',
    home: 'https://www.so.com',
    build: (q) => ({ url: `https://www.so.com/s?q=${encodeURIComponent(q)}&pn=1` }),
    detectBlock: (body) =>
      /请输入验证码|verify\.so\.com|访问过于频繁/.test(body) ? '触发 360 安全验证，需稍后重试' : null,
    parse: (body) => {
      const out = [];
      // 只取结果列表区，避开顶部导航里的 data-mdurl。
      const listStart = body.indexOf('<ul class="result"');
      const scope = listStart === -1 ? body : body.slice(listStart);
      for (const block of splitBlocks(scope, /<li class="res-list"/)) {
        const titleMatch = block.match(/<h3[^>]*>[\s\S]{0,300}?<a[^>]*>([\s\S]*?)<\/a>/);
        if (!titleMatch) continue;
        const mdurl = (block.match(/data-mdurl="([^"]+)"/) || [])[1];
        const href = (block.match(/<h3[^>]*>[\s\S]{0,300}?<a[^>]*href="([^"]+)"/) || [])[1];
        const url = pick360Url(mdurl, href);
        if (!url) continue;
        const snippet =
          (block.match(/class="res-desc"[^>]*>([\s\S]*?)<\/p>/) || [])[1] ||
          (block.match(/class="res-rich[^"]*"[^>]*>([\s\S]*?)<\/p>/) || [])[1] ||
          (block.match(/<p class="res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/) || [])[1];
        out.push({ title: plainText(titleMatch[1]), url, snippet: plainText(snippet).slice(0, 300) });
      }
      return out;
    },
  },

  sogou: {
    id: 'sogou',
    label: '搜狗',
    region: 'cn',
    home: 'https://www.sogou.com',
    build: (q) => ({ url: `https://www.sogou.com/web?query=${encodeURIComponent(q)}` }),
    // 搜狗对无 cookie 的首次请求常给空壳，先取一次首页拿 cookie。
    prepare: async (ctx) => {
      const home = await ctx.fetch('https://www.sogou.com/', { timeout: 10000 });
      return home.cookies;
    },
    // 搜狗按 IP 限流，连续检索后会甩出验证码页（约 5KB）。
    // 这必须显式报出来，否则用户只会看到"0 条结果"而不知道是被拦了。
    detectBlock: (body) =>
      /SourceVerifyCode|需要您协助验证|请输入验证码/.test(body) ? '触发搜狗验证码（本机 IP 被临时限流），稍后再试' : null,
    parse: (body) => {
      const out = [];
      for (const block of splitBlocks(body, /<div class="vrwrap"/)) {
        const m = block.match(/<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>[\s\S]{0,300}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!m) continue;
        const url = pickSogouUrl(m[1]);
        if (!url) continue;
        const snippet =
          (block.match(/class="[^"]*space-txt[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] ||
          (block.match(/class="[^"]*str_info[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] ||
          (block.match(/class="[^"]*text-layout[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
        out.push({ title: plainText(m[2]), url, snippet: plainText(snippet).slice(0, 300) });
      }
      return out;
    },
    // 搜狗的 /link?url= 是个只含 JS 跳转的壳页，里面才有真实地址；
    // 并发把这几个壳页换回真实 URL，代价约一轮 RTT。
    async resolveLinks(results, ctx) {
      const targets = results.filter((r) => /sogou\.com\/link\?/.test(r.url));
      await Promise.all(
        targets.map(async (r) => {
          try {
            const res = await ctx.fetch(r.url, { maxRedirects: 0, timeout: 8000 });
            const m =
              res.body.match(/location\.replace\("([^"]+)"\)/) ||
              res.body.match(/URL='([^']+)'/);
            if (m && isHttpUrl(m[1])) r.url = m[1];
          } catch {
            /* 还原失败就保留原跳转链接，它在浏览器里仍可用 */
          }
        })
      );
      return results;
    },
  },

  github: {
    id: 'github',
    label: 'GitHub',
    region: 'global',
    home: 'https://github.com',
    build: (q, limit) => ({
      // 不按 star 排序：实测 sort=stars 会把高星但无关的仓库顶上来
      // （搜 "React 19 新特性" 能搜出政治类高星库）。默认 best-match 相关性明显更好。
      url: `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 30)}`,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    }),
    parse: (body) => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return [];
      }
      if (!Array.isArray(data.items)) return [];
      return data.items.map((it) => {
        const stars = it.stargazers_count ?? 0;
        const lang = it.language ? ` · ${it.language}` : '';
        return {
          title: it.full_name,
          url: it.html_url,
          snippet: `${(it.description || '(无描述)').slice(0, 200)} · ⭐ ${stars}${lang}`,
        };
      });
    },
    // GitHub Search API 未认证时限速 10 次/分钟，命中限速时给出可读提示。
    note: (status) => (status === 403 || status === 429 ? 'GitHub API 触发限速（未认证 10 次/分钟），稍后重试' : null),
  },

  google: {
    id: 'google',
    label: 'Google',
    region: 'global',
    home: 'https://www.google.com',
    // Google 网页版对无 JS 请求只返回"请升级浏览器"壳页面，
    // 稳定可用的是 Google 新闻的 RSS 检索。
    kind: 'news',
    build: (q) => ({ url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&ceid=CN:zh-Hans` }),
    parse: (body) =>
      parseRssItems(body, {
        mapTitle: (rawTitle, pick) => {
          // 标题形如 "标题 - 来源"，拆出干净标题与来源。
          const source = (rawTitle.match(/\s+-\s+([^-]+)$/) || [])[1];
          const title = rawTitle.replace(/\s+-\s+[^-]+$/, '').trim() || rawTitle;
          const date = pick('pubDate');
          let day = '';
          try {
            day = date ? new Date(date).toISOString().slice(0, 10) : '';
          } catch {
            day = '';
          }
          const snippet = [source && `来源: ${source.trim()}`, day && `时间: ${day}`].filter(Boolean).join(' · ');
          return { title, snippet };
        },
      }),
  },

  yahoo: {
    id: 'yahoo',
    label: 'Yahoo',
    region: 'global',
    home: 'https://search.yahoo.com',
    build: (q, limit) => ({ url: `https://search.yahoo.com/search?p=${encodeURIComponent(q)}&n=${Math.min(limit + 5, 30)}` }),
    // Yahoo 会先回 307 到 /_bv/v.gif 并下发 YBV/A1 cookie，带 cookie 重放才给结果。
    // 但它并非每次都发挑战：有时首个响应就是壳页，有时重放会被回 500。
    // 所以判据不是状态码，而是"有没有解析出结果"，没解析出来就退避重放。
    search: async (query, ctx) => {
      const url = ENGINES.yahoo.build(query, ctx.limit).url;
      const first = await ctx.fetch(url, { maxRedirects: 0 });
      const firstResults = ENGINES.yahoo.parse(first.body);
      if (firstResults.length) return firstResults;

      let lastStatus = `首次 HTTP ${first.status}`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt) await new Promise((r) => setTimeout(r, 400));
        const replay = await ctx.fetch(url, { cookies: first.cookies, maxRedirects: 2 });
        lastStatus += `，重放${attempt + 1} HTTP ${replay.status}`;
        const replayed = ENGINES.yahoo.parse(replay.body);
        if (replayed.length) return replayed;
      }
      throw new Error(`未取得结果（${lastStatus}）`);
    },
    parse: (body) => {
      const out = [];
      // data-yga 里的 yModType 标出广告位（ad）与自然结果（algo）；
      // 标题链接带 data-matarget="algo"，广告是 "ad"。
      for (const block of splitBlocks(body, /<div class="dd[^"]*\balgo\b[^"]*"/)) {
        if (!/data-matarget="algo"/.test(block)) continue;
        const linkMatch = block.match(/<a[^>]*data-matarget="algo"[^>]*href="([^"]+)"/);
        if (!linkMatch) continue;
        const url = pickYahooUrl(linkMatch[1]);
        if (!url) continue;
        // 标题要取 h3.title 里的 span；直接取 <a> 的文本会把站点名、
        // 面包屑和 favicon 那些无障碍文本一起吞进来（"zcode.z.ai https://zcode.z.ai › cn › docs"）。
        const h3 = block.match(/<h3[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/);
        const title = plainText(h3 ? h3[1] : '');
        if (!title) continue;
        const snippet =
          (block.match(/class="[^"]*compText[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] ||
          (block.match(/<p class="[^"]*"[^>]*>([\s\S]*?)<\/p>/) || [])[1];
        out.push({ title, url, snippet: plainText(snippet).slice(0, 300) });
      }
      return out;
    },
  },

  duckduckgo: {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    region: 'global',
    home: 'https://duckduckgo.com',
    // 必须带完整浏览器指纹头，否则拿到的是 202 空壳页（约 14KB，只有壳没有结果）。
    build: (q) => ({ url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, headers: BROWSER_HEADERS }),
    detectBlock: (body) =>
      !/result__a|result__snippet/.test(body) && /<title>\s*DuckDuckGo\s*<\/title>/.test(body)
        ? '返回反爬空壳页（浏览器指纹未被接受），稍后重试'
        : null,
    parse: (body) => {
      const out = [];
      const titles = [...body.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      const snippets = [...body.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
      titles.forEach((m, i) => {
        const url = pickDdgUrl(m[1]);
        const title = plainText(m[2]);
        if (!url || !title) return;
        out.push({ title, url, snippet: plainText(snippets[i] ? snippets[i][1] : '').slice(0, 300) });
      });
      return out;
    },
  },
};

/* --------------------------- 跳转链接还原 --------------------------- */

function isHttpUrl(u) {
  return /^https?:\/\//i.test(u || '');
}

/** 百度：优先 mu 属性（真实 URL），其次 h3 的 href（多为 /link?url= 跳转）。 */
function pickBaiduUrl(mu, href) {
  const muClean = cleanUrl(mu);
  if (isHttpUrl(muClean) && !/baidu\.com\/(?:baidu\.php|link)/i.test(muClean)) return muClean;
  const hrefClean = cleanUrl(href);
  if (isHttpUrl(hrefClean) && !/baidu\.com\/(?:baidu\.php|link)/i.test(hrefClean)) return hrefClean;
  return hrefClean.startsWith('/') ? `https://www.baidu.com${hrefClean}` : null;
}

/** 360：data-mdurl 是投放的真实 URL。 */
function pick360Url(mdurl, href) {
  const md = cleanUrl(mdurl);
  if (isHttpUrl(md)) return md;
  const h = cleanUrl(href);
  if (isHttpUrl(h) && !/so\.com\/link/i.test(h)) return h;
  return null;
}

/** 搜狗：href 可能是 /link?url= 相对跳转，补全域名。 */
function pickSogouUrl(href) {
  const h = cleanUrl(href);
  if (!h) return null;
  if (h.startsWith('/link?')) return `https://www.sogou.com${h}`;
  return isHttpUrl(h) ? h : null;
}

/** Yahoo：真实地址在 r.search.yahoo.com 的 /RU=<encoded>/RK= 段里。 */
function pickYahooUrl(href) {
  const h = cleanUrl(href);
  const ru = h.match(/\/RU=([^/]+)\//);
  if (ru) {
    try {
      const decoded = decodeURIComponent(ru[1]);
      if (isHttpUrl(decoded)) return decoded;
    } catch {
      /* 解码失败则退回原 href */
    }
  }
  return isHttpUrl(h) ? h : null;
}

/** DuckDuckGo：结果链接是 //duckduckgo.com/l/?uddg=<encoded>。 */
function pickDdgUrl(href) {
  const h = cleanUrl(href);
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      const decoded = decodeURIComponent(m[1]);
      if (isHttpUrl(decoded)) return decoded;
    } catch {
      /* 忽略 */
    }
  }
  if (h.startsWith('//')) return `https:${h}`;
  return isHttpUrl(h) ? h : null;
}

/* ------------------------------ 引擎调用 ------------------------------ */

/**
 * 跑一个引擎。
 * @returns {Promise<{id,label,region,status:'ok'|'empty'|'error',results:Array,tookMs,error?,viaProxy?}>}
 */
export async function runEngine(engine, query, ctx) {
  const started = Date.now();
  const base = { id: engine.id, label: engine.label, region: engine.region, results: [] };
  try {
    const cookies = engine.prepare ? await engine.prepare(ctx) : '';
    let results;
    let status = 200;
    let viaProxy = false;

    if (engine.search) {
      results = await engine.search(query, { ...ctx, cookies });
    } else {
      const spec = engine.build(query, ctx.limit);
      const res = await ctx.fetch(spec.url, {
        method: spec.method || 'GET',
        headers: spec.headers || {},
        body: spec.body || null,
        cookies,
      });
      status = res.status;
      viaProxy = res.viaProxy;
      if (res.status >= 400) {
        return { ...base, status: 'error', error: `HTTP ${res.status}`, tookMs: Date.now() - started };
      }
      // 反爬拦截页往往带着 200 回来，必须在解析前认出来。
      const blocked = engine.detectBlock ? engine.detectBlock(res.body) : null;
      if (blocked) {
        return { ...base, status: 'error', error: blocked, tookMs: Date.now() - started };
      }
      results = engine.parse(res.body, { query });
    }

    const note = engine.note ? engine.note(status) : null;
    let trimmed = results.slice(0, ctx.limit);
    // 跳转链接还原放在截断之后，只对真正要返回的条目付这份请求代价。
    if (engine.resolveLinks && trimmed.length) {
      trimmed = await engine.resolveLinks(trimmed, ctx);
    }
    return {
      ...base,
      status: trimmed.length ? 'ok' : 'empty',
      results: trimmed,
      tookMs: Date.now() - started,
      viaProxy,
      ...(note ? { note } : {}),
    };
  } catch (e) {
    return { ...base, status: 'error', error: e.name === 'Error' ? e.message : `${e.name}: ${e.message}`, tookMs: Date.now() - started };
  }
}
