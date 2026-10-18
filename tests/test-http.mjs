/**
 * HTTP 层单元测试：起本地服务器，覆盖 gzip、chunked、重定向、Cookie、
 * 以及"既无 Content-Length 也无 chunked、靠连接关闭收尾"这几种响应形态。
 * 不依赖外网。用法：node tests/test-http.mjs
 */
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { request, mergeCookies, probeProxy } from '../mcp/http.mjs';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ---- 1. 普通 HTTP 服务器：gzip / chunked / 重定向 / cookie ---- */
const server = http.createServer((req, res) => {
  if (req.url === '/gzip') {
    const body = zlib.gzipSync(Buffer.from('压缩后的内容 gzip-ok 中文'));
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip', 'Content-Length': body.length });
    res.end(body);
  } else if (req.url === '/chunked') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
    res.write('chunk1-');
    res.write('chunk2-');
    res.end('chunk3');
  } else if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/final', 'Set-Cookie': 'sid=abc; Path=/; HttpOnly' });
    res.end();
  } else if (req.url === '/redirect307') {
    res.writeHead(307, { Location: '/echo', 'Set-Cookie': 'r7=1; Path=/' });
    res.end();
  } else if (req.url === '/final') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`final cookie=${req.headers.cookie || '(无)'}`);
  } else if (req.url === '/echo') {
    // 注意：Node 的 http server 不会自动填充 req.body，必须自己收流。
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.writeHead(200);
      res.end(`method=${req.method} body=${data}`);
    });
  } else if (req.url === '/cookie-chain') {
    // 累积多个 Set-Cookie，验证同名覆盖
    res.writeHead(200, { 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/', 'a=9; Path=/'] });
    res.end('ok');
  } else {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const gz = await request(`${base}/gzip`, { timeout: 5000 });
check('gzip 正确解压（不是双重解压）', gz.body === '压缩后的内容 gzip-ok 中文', JSON.stringify(gz.body.slice(0, 40)));

const ch = await request(`${base}/chunked`, { timeout: 5000 });
check('chunked 正确拼接', ch.body === 'chunk1-chunk2-chunk3', JSON.stringify(ch.body));

const rd = await request(`${base}/redirect`, { timeout: 5000 });
check('302 被跟随', rd.status === 200 && rd.body.startsWith('final'), `status=${rd.status}`);
check('302 的 Set-Cookie 带到了下一跳', rd.body.includes('sid=abc'), rd.body.slice(0, 60));

const r307 = await request(`${base}/redirect307`, { method: 'POST', body: 'hello=1', timeout: 5000 });
check('307 保留方法与请求体', /method=POST\s+body=hello=1/.test(r307.body), r307.body.slice(0, 40));

const ck = await request(`${base}/cookie-chain`, { timeout: 5000 });
check('同名 Cookie 后者覆盖前者', ck.cookies.includes('a=9') && !ck.cookies.includes('a=1'), ck.cookies);

check('mergeCookies 保留未涉及的旧 Cookie', mergeCookies('keep=1', ['x=2']) === 'keep=1; x=2', mergeCookies('keep=1', ['x=2']));

await new Promise((r) => server.close(r));

/* ---- 2. 裸 socket：既无 Content-Length 也无 chunked，靠 close 收尾 ---- */
const bare = net.createServer((sock) => {
  sock.on('data', () => {
    const payload = Buffer.from('无长度响应体-no-length');
    sock.write(
      'HTTP/1.1 200 OK\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${payload.length}\r\n` +   // 先给一个正常响应
      'Connection: close\r\n\r\n'
    );
    sock.write(payload);
    sock.end();
  });
});
await new Promise((r) => bare.listen(0, '127.0.0.1', r));
const bareUrl = `http://127.0.0.1:${bare.address().port}/`;

const bareRes = await request(bareUrl, { timeout: 5000 });
check('连接关闭收尾的响应可读取', bareRes.body === '无长度响应体-no-length', JSON.stringify(bareRes.body.slice(0, 30)));
await new Promise((r) => bare.close(r));

/* ---- 3. 超时与代理探活 ---- */
const slow = net.createServer((sock) => {
  sock.on('data', () => { /* 故意不回 */ });
});
await new Promise((r) => slow.listen(0, '127.0.0.1', r));
let timedOut = false;
try {
  await request(`http://127.0.0.1:${slow.address().port}/`, { timeout: 800 });
} catch (e) {
  timedOut = /timeout/i.test(e.message);
}
check('超时会抛出 timeout', timedOut);
await new Promise((r) => slow.close(r));

const noProxy = await probeProxy('127.0.0.1', 9);
check('探不到代理时返回 false（而不是抛异常）', noProxy === false);

/* ---- 4. 404 不抛异常，交给调用方判断 ---- */
const s404 = http.createServer((req, res) => { res.writeHead(404); res.end('x'); });
await new Promise((r) => s404.listen(0, '127.0.0.1', r));
const r404 = await request(`http://127.0.0.1:${s404.address().port}/`, { timeout: 5000 });
check('HTTP 4xx 正常返回状态码', r404.status === 404, `status=${r404.status}`);
await new Promise((r) => s404.close(r));

const failed = checks.filter((c) => !c.ok);
console.log(`\n===== ${checks.length - failed.length}/${checks.length} 项通过 =====`);
process.exit(failed.length ? 1 : 0);
