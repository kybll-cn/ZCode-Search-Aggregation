/**
 * 降级验证：代理关闭（等价于"访问不了外网"）时，
 * 境外引擎应失败并被记为不可达，大陆引擎照常返回结果；
 * 第二次查询应跳过已判定不可达的引擎，不再重复付超时代价。
 *
 * 用法：node tests/test-offline-fallback.mjs
 */
import { Aggregator } from '../mcp/aggregator.mjs';
import { ENGINES } from '../mcp/engines.mjs';

const agg = new Aggregator({ proxy: 'off', timeout: 6000, ttl: 60000 });

console.log('=== 第一次查询（代理关闭，境外引擎会超时）===');
const t1 = Date.now();
const r1 = await agg.search('zcode 插件', { limit: 3, force: true });
const d1 = Date.now() - t1;

const okIds = r1.engines.map((e) => e.id);
const errIds = r1.errors.map((e) => e.id);
console.log(`耗时 ${(d1 / 1000).toFixed(1)}s`);
console.log(`成功: ${okIds.join(', ') || '(无)'}`);
console.log(`失败: ${r1.errors.map((e) => `${e.id}(${e.error})`).join(', ') || '(无)'}`);
console.log(`跳过: ${r1.skipped.map((s) => s.id).join(', ') || '(无)'}`);

const cnOk = ['baidu', 'bing', 'so360', 'sogou'].filter((id) => okIds.includes(id));
const globalFailed = ['google', 'yahoo', 'duckduckgo'].filter((id) => errIds.includes(id));

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('');
check('大陆引擎在无外网时仍可用', cnOk.length >= 3, cnOk.join(', '));
check('无法直连的境外引擎被识别为失败', globalFailed.length >= 1, globalFailed.join(', '));
check('返回结果的引擎都在健康名单里', r1.engines.every((e) => agg.health.get(e.id)?.usable !== false));

const unhealthy = agg.healthSnapshot().filter((h) => !h.usable);
check('失败引擎已写入不可达缓存', unhealthy.length >= 1, unhealthy.map((h) => h.id).join(', '));

console.log('\n=== 第二次查询（应跳过不可达引擎，明显更快）===');
const t2 = Date.now();
const r2 = await agg.search('react hooks', { limit: 3 });
const d2 = Date.now() - t2;
console.log(`耗时 ${(d2 / 1000).toFixed(1)}s，成功: ${r2.engines.map((e) => e.id).join(', ')}`);
console.log(`被跳过: ${r2.skipped.map((s) => `${s.id}(${s.reason})`).join(', ') || '(无)'}`);

check('第二次查询跳过了上次失败的引擎', r2.skipped.some((s) => globalFailed.includes(s.id)));
check('第二次查询更快', d2 < d1, `${(d1 / 1000).toFixed(1)}s -> ${(d2 / 1000).toFixed(1)}s`);
check('第二次仍有大陆引擎结果', r2.engines.some((e) => ENGINES[e.id]?.region === 'cn'));

const failed = checks.filter((c) => !c.ok);
console.log(`\n===== ${checks.length - failed.length}/${checks.length} 项通过 =====`);
process.exit(failed.length ? 1 : 0);
