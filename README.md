# ZCode Search Aggregation

ZCode 的多引擎并行搜索插件。一次调用同时查询 **百度、必应、360、搜狗、GitHub、Google、Yahoo、DuckDuckGo**，把结果汇总、跨引擎去重后交给模型；**外网不可达时自动降级为只用大陆搜索引擎**。

零依赖：只用 Node 内置模块，不需要 `npm install`。

---

## 特性

- **真并行**：八个引擎同时发起请求，总耗时约等于最慢的那一个，而不是八个串行相加。
- **自动降级**：境外引擎（Google / Yahoo / DuckDuckGo）一旦因网络不可达失败，会被记入"近期不可达"并跳过；后续检索不再重复等超时。
- **代理自动发现**：默认探测本机常见的代理端口（Clash `7897`/`7890`、v2rayN `10809` 等），探测不到就全部直连，无需手填配置。
- **跨引擎去重**：同一个 URL 只保留首次命中的那条，重复条数单独记录。
- **诚实报错**：被验证码、限流或反爬空壳页拦住时，明确说明是哪家、什么原因，不会静默返回 0 条让模型以为"网上没有"。
- **两种呈现**：按引擎分组（便于对比来源）或交错混排（便于通读）。

## 安装

### 通过插件市场

把本仓库根目录（`marketplace.json` 所在目录）作为插件市场添加：

**插件市场 → 添加 → 添加插件市场**，粘贴仓库绝对路径，然后 **个人 → dev-zcode-plugins → 搜索聚合 → 安装**。

### 手动配置 MCP

把 `mcp/server.mjs` 挂到任意 ZCode 配置的 `mcpServers` 下：

```json
{
  "mcpServers": {
    "search-aggregation": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/ZCode-Search-Aggregation/mcp/server.mjs"],
      "env": { "SEARCH_PROXY": "auto", "SEARCH_TIMEOUT": "15000" },
      "timeoutMs": 120000
    }
  }
}
```

要求 Node 18+。装了插件市场后 `.mcp.json` 会用 `command: "node"` 启动，因此 `node` 需要在 PATH 里。

**如果机器上没有全局 `node`**，可以借 ZCode 自带的运行时（官方插件用的就是这个方式），把 `command`/`args` 换成：

```json
{
  "command": "<ZCode 安装目录>/ZCode.exe",
  "args": [
    "<ZCode 安装目录>/resources/glm/zcode.cjs",
    "__zcode-plugin-host",
    "/absolute/path/to/ZCode-Search-Aggregation/mcp/server.mjs"
  ],
  "env": { "ELECTRON_RUN_AS_NODE": "1" },
  "timeoutMs": 120000
}
```

## 使用

模型侧的工具是 `web_search`：

```
web_search(query: "zcode 插件", limit: 5)
web_search(query: "react 19 新特性", engines: ["baidu", "bing"], mode: "interleave")
web_search(query: "python asyncio", force: true)     # 网络恢复后强制重试全部引擎
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `query` | 必填 | 关键词，中英文皆可 |
| `engines` | 自动 | 指定引擎；默认选当前可达的全部 |
| `limit` | 5 | 每个引擎返回条数（1–20） |
| `mode` | `group` | `group` 按引擎分组；`interleave` 交错混排 |
| `force` | false | 忽略"近期不可达"缓存，强制重试 |

辅助工具 `search_engines`：查看各引擎可达状态；`probe: true` 时实际发探测请求，用来确认外网或代理是否通。

配套 `/search <关键词>` 命令，以及 `search-aggregation` 技能（模型在需要联网检索时会自动参考）。

## 各引擎是怎么抓的

所有解析规则都是按**实测抓到的真实页面结构**写的（样本存于 `tests/fixtures/`），不是照文档或记忆写的正则。各家的取数方式并不一样：

| 引擎 | 区域 | 实现方式 |
| --- | --- | --- |
| 百度 | 直连 | 抓搜索结果页，从结果容器的 `mu` 属性取**真实 URL**（页面上可见的 `baidu.com/link?url=` 是跳转链，不含目标地址），标题取 `h3`。 |
| 必应 | 直连 | 走 `www.bing.com` 的 `format=rss` 官方结构化输出，直接拿到标题/URL/摘要，比抓 HTML 稳得多。 |
| 360搜索 | 直连 | 限定在结果列表 `<ul class="result">` 内解析，用 `data-mdurl` 属性还原真实 URL（否则会把顶部导航的链接当结果）。 |
| 搜狗 | 直连 | 先取一次首页拿 Cookie 再检索；结果里的 `/link?url=` 是只含 JS 跳转的壳页，插件会并发把这几个壳页换回真实地址。 |
| GitHub | 直连/代理 | 走官方 Search API（仓库搜索），JSON 直读，不解析 HTML。 |
| Google | 需代理 | 网页版对无 JS 请求只返回"请升级浏览器"壳页面，稳定可用的是 **Google 新闻的 RSS 检索**——所以 Google 这一路给的是**新闻条目**，不是普通网页结果。 |
| Yahoo | 需代理 | 先回 307 到 beacon 并下发 Cookie，带 Cookie 重放才给结果；真实地址藏在 `r.search.yahoo.com/.../RU=<编码地址>/RK=` 里，会解码还原；广告位用 `data-matarget="ad"` 排除。 |
| DuckDuckGo | 需代理 | 必须带完整浏览器指纹头（`Sec-Fetch-*`、`Sec-CH-UA` 等），否则拿到的是 202 空壳页；结果链接的 `uddg=` 参数解出真实地址。 |

**为什么必应要特意用 `www` 而不是 `cn`**：实测 `cn.bing.com` 在本机网络下会返回与查询完全无关的降级内容（查 "zcode 插件" 却给出车牌号、儿歌），`www.bing.com` 才返回正确结果。这是踩过的坑，写在代码注释里了。

## 外网不可达时的行为

这是插件的核心设计之一，实测数据：

```
=== 第一次查询（代理关闭，境外引擎会超时）===
耗时 6.0s
成功: baidu, bing, so360, github
失败: google(connect timeout), yahoo(connect timeout), duckduckgo(connect timeout)

=== 第二次查询（跳过不可达引擎）===
耗时 0.9s
被跳过: google, yahoo, duckduckgo
```

机制：每个引擎的可达性带缓存。因网络原因失败（超时、连不上、5xx）标记为不可达并跳过，**5 分钟后自动再试**；被反爬拦截（验证码、安全验证）则冷却 **15 分钟**——因为 5 分钟就回去重试只会继续触发风控、反而拖长封禁。网络恢复时也可以直接 `force: true` 立即重试全部。

注意区分两类失败：**网络不可达**记为不可用并跳过；**HTTP 正常但解析不出结果**不记为网络问题（那多半是站点改版或关键词太窄），会照常重试。

## 已知限制（诚实地列出来）

- **密集检索会被限流，这是所有抓取式搜索的通病**。实测连续快速跑多轮测试后，搜狗会甩出验证码页、百度会要求安全验证、Yahoo 会回 500；正常使用频率（偶尔搜几次）下各家都稳定。插件遇到这类拦截会**明确报出是哪家、什么原因**并临时跳过它，不会静默返回"0 条结果"让模型误以为网上没有资料。
- **Google 只有新闻**。网页搜索需要 JS，纯 HTTP 抓不到；Google 这一路给的是新闻条目，链接是 `news.google.com` 的跳转地址（在浏览器里能正常打开原文，但 URL 本身不是原文地址）。
- **搜狗结果里的 `/link?url=` 需要在浏览器打开才跳转**：插件会并发把它换成真实地址，少数换不出来的会保留原跳转链接。
- **GitHub 搜的是仓库**，不是代码内容，且未认证 API 限速 10 次/分钟。
- **站点改版会让解析失效**。某个引擎持续返回 0 条但状态可达，通常意味着它的页面结构变了，需要按新结构更新 `mcp/engines.mjs` 里的解析器。
- 结果质量受引擎本身影响：冷门或含歧义的关键词，引擎可能返回不相关内容，使用时应核对标题与摘要是否对题。

## 项目结构

```
.zcode-plugin/plugin.json   插件清单（含 userConfig：代理、超时）
.mcp.json                   MCP server 注册
mcp/http.mjs                零依赖 HTTP 客户端（直连/代理隧道、gzip、重定向、Cookie）
mcp/engines.mjs             八个引擎的定义、解析器、跳转链接还原
mcp/aggregator.mjs          并行调度、代理发现、可达性缓存、去重
mcp/server.mjs              MCP 协议层与工具定义
skills/                     技能说明（给模型的使用指引）
commands/search.md          /search 命令
tests/                      真实网络测试与页面样本
```

## 开发与测试

```bash
# HTTP 层单元测试：本地起服务器，验证 gzip/chunked/重定向/Cookie/超时，不依赖外网
node tests/test-http.mjs

# 引擎级：逐引擎真实查询，打印提取到的标题与 URL
node tests/test-engines.mjs "查询词"

# 稳定性：多查询词跑全部引擎，统计成功率
node tests/test-stability.mjs

# 降级：验证无外网时只用大陆引擎，且第二次查询会跳过不可达引擎
node tests/test-offline-fallback.mjs

# 端到端：真的把 server 当子进程启动，走 JSON-RPC 全流程
node tests/test-mcp.mjs

# 重新抓取各引擎真实响应，存到 tests/fixtures/（改解析器前先跑这个）
node tests/capture-fixtures.mjs "查询词"
```

改解析器的工作流：先 `capture-fixtures.mjs` 抓一份当前的真实页面，对着它写正则，再跑 `test-engines.mjs` 验证。

> 注意：测试会真实发请求，**连续跑多轮会触发各家的 IP 限流**（搜狗验证码、百度安全验证、Yahoo 500）。这是抓取式搜索的固有代价，不是测试或插件有问题——间隔几分钟再跑就恢复正常。

## 许可

MIT
