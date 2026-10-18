/**
 * 零依赖 HTTP 客户端。
 *
 * 只用 node: 内置模块，因为插件安装方不一定能跑 npm install。
 * 能力：直连 / HTTP CONNECT 代理隧道、自动解压（gzip/deflate/br）、跟随重定向、超时。
 */

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { URL } from 'node:url';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 常见本地代理端口，按流行度排序（Clash / v2rayN / 通用）。 */
export const COMMON_PROXY_PORTS = [7897, 7890, 10809, 1080, 8080, 8888, 1087, 2080, 20171];

function decompress(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') return zlib.inflateSync(buffer);
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    // 有些站点声称 gzip 但实际发的是明文，解压失败就原样返回。
    return buffer;
  }
  return buffer;
}

/** 解析响应头块；重复的头（如 Set-Cookie）收集成数组。 */
function parseHead(rawHead) {
  const lines = rawHead.split('\r\n');
  const statusMatch = (lines[0] || '').match(/^HTTP\/[\d.]+\s+(\d{3})/);
  const headers = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (headers[key] === undefined) headers[key] = value;
    else if (Array.isArray(headers[key])) headers[key].push(value);
    else headers[key] = [headers[key], value];
  }
  return { status: statusMatch ? parseInt(statusMatch[1], 10) : 0, headers };
}

/** 在已建立的 socket 上按 HTTP 协议取一次响应。 */
function readResponse(socket, { timeoutMs, onTimeout }) {
  return new Promise((resolve, reject) => {
    let raw = Buffer.alloc(0);
    let settled = false;
    const timer = timeoutMs ? setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(onTimeout || new Error('timeout'));
    }, timeoutMs) : null;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners('data');
      if (err) reject(err); else resolve(value);
    };

    socket.on('data', (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      // 头没读完就继续缓冲；头读完再看是否已收满 body。
      const headEnd = raw.indexOf('\r\n\r\n');
      if (headEnd === -1) return;

      const { status, headers } = parseHead(raw.slice(0, headEnd).toString('latin1'));
      if (!status) return done(new Error('bad status line'));

      const bodyStart = headEnd + 4;
      const isChunked = /chunked/i.test(headers['transfer-encoding'] || '');
      const declared = headers['content-length'] ? parseInt(headers['content-length'], 10) : null;

      if (isChunked) {
        const parsed = decodeChunked(raw.slice(bodyStart));
        if (parsed === null) return; // 还没收完，等下一块
        return done(null, { status, headers, rawBody: parsed });
      }
      if (declared !== null) {
        if (raw.length - bodyStart < declared) return; // 等收满
        return done(null, { status, headers, rawBody: raw.slice(bodyStart, bodyStart + declared) });
      }
      // 没有 length 也没有 chunked：靠连接关闭判断结束（'end' 事件处理）。
    });

    socket.on('end', () => {
      const headEnd = raw.indexOf('\r\n\r\n');
      if (headEnd === -1) return done(new Error('connection closed before headers'));
      const { status, headers } = parseHead(raw.slice(0, headEnd).toString('latin1'));
      const body = raw.slice(headEnd + 4);
      // 这里同样只给原始字节，解压统一由 request 做，避免双重解压。
      done(null, {
        status,
        headers,
        rawBody: /chunked/i.test(headers['transfer-encoding'] || '') ? (decodeChunked(body) || body) : body,
      });
    });

    socket.on('error', (err) => done(err));
    socket.on('close', () => {
      // 若是被我们自己 destroy 的（超时/提前完成），不重复处理。
      if (!settled) done(new Error('socket closed'));
    });
  });
}

/** 解析 chunked 传输体；数据不完整时返回 null。 */
function decodeChunked(buf) {
  const parts = [];
  let pos = 0;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd === -1) return null;
    const sizeLine = buf.slice(pos, lineEnd).toString('latin1').split(';')[0].trim();
    const size = parseInt(sizeLine, 16);
    if (Number.isNaN(size)) return null;
    if (size === 0) return Buffer.concat(parts);
    const start = lineEnd + 2;
    if (buf.length < start + size + 2) return null;
    parts.push(buf.slice(start, start + size));
    pos = start + size + 2;
  }
}

/** 建立一个到目标主机的 socket（直连或经代理 CONNECT）。 */
function openSocket({ targetHost, targetPort, useTls, proxy, timeoutMs, servername }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`connect timeout (${targetHost})`)), timeoutMs);

    if (!proxy) {
      const socket = useTls
        ? tls.connect({ host: targetHost, port: targetPort, servername: servername || targetHost })
        : net.connect({ host: targetHost, port: targetPort });
      socket.once(useTls ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(socket); });
      socket.once('error', (e) => { clearTimeout(timer); reject(e); });
      return;
    }

    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {},
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error(`proxy CONNECT ${res.statusCode}`));
      }
      if (!useTls) { clearTimeout(timer); return resolve(socket); }
      const tlsSocket = tls.connect({ socket, servername: servername || targetHost });
      tlsSocket.once('secureConnect', () => { clearTimeout(timer); resolve(tlsSocket); });
      tlsSocket.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.once('error', (e) => { clearTimeout(timer); reject(e); });
    req.once('timeout', () => { clearTimeout(timer); req.destroy(); reject(new Error('proxy timeout')); });
    req.end();
  });
}

/** 把 Set-Cookie 头合并进一个简单的 Cookie 串（同名后写覆盖先写）。 */
export function mergeCookies(existing, setCookieHeaders) {
  const jar = new Map();
  const put = (pair) => {
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  };
  for (const pair of String(existing || '').split(';')) if (pair.trim()) put(pair.trim());
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : (setCookieHeaders ? [setCookieHeaders] : []);
  for (const raw of list) put(String(raw).split(';')[0]);
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 发一次 HTTP(S) 请求。
 * @returns {Promise<{status:number, headers:object, body:string, url:string, viaProxy:boolean, cookies:string}>}
 */
export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 15000,
    maxRedirects = 4,
    proxy = null,
    userAgent = DEFAULT_UA,
    cookies = '',
    _redirects = 0,
  } = options;

  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const targetPort = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);

  const finalHeaders = {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'close',
    ...headers,
  };
  if (cookies) finalHeaders.Cookie = cookies;
  if (body != null && !finalHeaders['Content-Length']) {
    finalHeaders['Content-Length'] = Buffer.byteLength(body);
  }

  const socket = await openSocket({
    targetHost: parsed.hostname,
    targetPort,
    useTls: isHttps,
    // 代理只用于 HTTPS 的 CONNECT 隧道；明文 HTTP 目标一律直连。
    proxy: isHttps ? proxy : null,
    timeoutMs: timeout,
    servername: parsed.hostname,
  });

  const requestLine = `${method} ${parsed.pathname}${parsed.search} HTTP/1.1`;
  const headerLines = Object.entries({ Host: parsed.host, ...finalHeaders })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');

  return new Promise((resolve, reject) => {
    const pending = readResponse(socket, { timeoutMs: timeout });
    socket.write(`${requestLine}\r\n${headerLines}\r\n\r\n`);
    if (body != null) socket.write(body);

    pending.then(async (res) => {
      const encoding = res.headers['content-encoding'];
      const text = decompress(res.rawBody, encoding).toString('utf8');
      const nextCookies = mergeCookies(cookies, res.headers['set-cookie']);

      const location = res.headers.location;
      if (location && res.status >= 300 && res.status < 400 && maxRedirects > 0) {
        const nextUrl = new URL(location, url).toString();
        // 307/308 保留方法与请求体，301/302/303 按 GET 处理。
        const keepMethod = (res.status === 307 || res.status === 308) && method !== 'GET';
        try {
          const followed = await request(nextUrl, {
            ...options,
            method: keepMethod ? method : 'GET',
            body: keepMethod ? body : null,
            cookies: nextCookies,
            maxRedirects: maxRedirects - 1,
            _redirects: _redirects + 1,
          });
          return resolve(followed);
        } catch (e) {
          return reject(e);
        }
      }
      resolve({ status: res.status, headers: res.headers, body: text, url, viaProxy: !!proxy, cookies: nextCookies });
    }).catch(reject);
  });
}

/** 用代理端口探活：能否 CONNECT 到指定主机。 */
export function probeProxy(host, port, target = 'www.google.com:443', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request({
      host, port, method: 'CONNECT', path: target, timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode === 200); });
    req.once('error', () => resolve(false));
    req.once('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
