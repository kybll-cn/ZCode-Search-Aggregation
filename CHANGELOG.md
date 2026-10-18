# Changelog

本项目的所有重要变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-19

首个公开版本。

### 新增

- **八引擎并行搜索**：百度、必应、360搜索、搜狗、GitHub、Google、Yahoo、DuckDuckGo 同时发起查询，总耗时约等于最慢的那一个。
- **外网不可达自动降级**：境外引擎因网络失败会被标记并跳过，等价于只用大陆搜索引擎；实测第二次查询从 6.0s 降到 0.8s。网络类故障冷却 5 分钟、反爬拦截冷却 15 分钟，到期自动重试，也可用 `force: true` 立即重试。
- **代理自动发现**：默认探测本机常见代理端口（Clash `7897`/`7890`、v2rayN `10809` 等），探测不到就全部直连；可用 `userConfig.proxy` 指定或关闭。
- **跨引擎去重**：同一 URL 只保留首次命中的条目，重复数单独记录。
- **拦截识别**：被验证码、安全验证或反爬空壳页拦住时明确报出引擎与原因，不静默返回 0 条。
- **两种呈现**：`group`（按引擎分组，便于对比来源）与 `interleave`（交错混排，便于通读）。
- `search_engines` 工具：查看各引擎可达状态，`probe: true` 可实时探测。
- `search-aggregation` 技能与 `/search` 命令。
- 零外部依赖：只用 Node 内置模块，无需 `npm install`。

### 各引擎的取数方式（按实测页面结构实现）

- **百度**：从结果容器的 `mu` 属性取真实 URL（页面上的 `baidu.com/link?url=` 是跳转链）。
- **必应**：走 `www.bing.com` 的官方 `format=rss` 通道。**注意不能用 `cn.bing.com`**——实测它会返回与查询无关的降级内容。
- **360搜索**：限定在结果列表内解析，用 `data-mdurl` 还原真实 URL。
- **搜狗**：先取首页拿 Cookie 再检索；结果里的 `/link?url=` 壳页并发换回真实地址。
- **GitHub**：官方 Search API（仓库搜索），按相关性排序而非 star 数。
- **Google**：网页版对无 JS 请求只返回"请升级浏览器"壳页，因此走 Google 新闻 RSS，结果是新闻条目。
- **Yahoo**：处理 307 挑战 + Cookie 重放，从 `/RU=` 参数解码真实地址。
- **DuckDuckGo**：带完整浏览器指纹头，否则只返回 202 空壳页。

### 已验证

- HTTP 层单元测试 11/11（gzip/chunked/重定向/Cookie/超时，不依赖外网）
- MCP 端到端测试 16/16（含模拟 ZCode 真实客户端参数的握手与调用）
- 降级路径测试 7/7
- 跨平台：Linux + Node 18 下通过

### 已知限制

- Google 只有新闻条目，不是网页搜索。
- GitHub 对中文关键词不敏感（实测 "python 装饰器用法" 0 条，"python decorator" 5 条）。
- 密集检索会触发各家限流（搜狗验证码、百度安全验证、Yahoo 500），正常使用频率下无此问题。
- 站点改版会导致对应引擎解析失效，需要按新结构更新解析器。

[1.0.0]: https://cnb.cool/kybll/ZCode-Search-Aggregation/releases/tag/v1.0.0
