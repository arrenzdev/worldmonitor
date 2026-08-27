import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { extname, normalize, resolve, sep } from 'node:path';

const root = resolve(process.env.OSINT_STATIC_ROOT ?? '');
const backendUrl = new URL(process.env.OSINT_BACKEND_URL ?? 'http://127.0.0.1:8000');
const requestedPort = Number.parseInt(process.env.OSINT_HOST_PORT ?? '0', 10);
const portFile = process.env.OSINT_PORT_FILE;
const adminKey = process.env.OSINT_ADMIN_KEY ?? '';

if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
  throw new Error(`OSINT static root is missing: ${root}`);
}
if (backendUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(backendUrl.hostname)) {
  throw new Error('OSINT backend must be a loopback HTTP endpoint');
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function safeStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname.split('?')[0] || '/');
  } catch {
    return null;
  }
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = resolve(root, relative || 'index.html');
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    const index = resolve(candidate, 'index.html');
    if (existsSync(index) && statSync(index).isFile()) return index;
  }
  const fallback = resolve(root, 'index.html');
  return existsSync(fallback) ? fallback : null;
}

function copyResponseHeaders(source, response) {
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (['connection', 'content-length', 'content-security-policy', 'transfer-encoding', 'x-frame-options'].includes(lower)) continue;
    if (value !== undefined) response.setHeader(name, value);
  }
}

function proxyHttp(req, res) {
  const forwardedHeaders = { ...req.headers, host: backendUrl.host, connection: 'close' };
  delete forwardedHeaders['x-admin-key'];
  if (adminKey) forwardedHeaders['x-admin-key'] = adminKey;
  const upstream = httpRequest({
    protocol: 'http:',
    hostname: backendUrl.hostname,
    port: backendUrl.port,
    method: req.method,
    path: req.url,
    headers: forwardedHeaders,
  }, (upstreamResponse) => {
    res.statusCode = upstreamResponse.statusCode ?? 502;
    copyResponseHeaders(upstreamResponse.headers, res);
    upstreamResponse.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end('{"error":"Managed OSINT backend unavailable"}');
  });
  req.pipe(upstream);
}

function serveManagedAdminSession(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method ?? 'GET')) {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, POST, DELETE' });
    res.end('{"ok":false,"detail":"method_not_allowed"}');
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(req.method === 'GET'
    ? '{"ok":true,"hasSession":true}'
    : '{"ok":true,"hasSession":true}');
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  // Shadowbroker's static desktop export normally relies on its own Tauri IPC
  // bridge instead of the browser cookie endpoint. Inside World Monitor it is
  // hosted in an isolated iframe, so report the host-owned admin session here;
  // the proxy still removes caller-provided keys and injects its private key.
  if (pathname === '/api/admin/session') {
    serveManagedAdminSession(req, res);
    return;
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    proxyHttp(req, res);
    return;
  }

  const file = safeStaticPath(pathname);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const stat = statSync(file);
  res.writeHead(200, {
    'content-type': contentTypes.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'content-security-policy': "frame-ancestors http://127.0.0.1:* http://localhost:*",
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = connectTcp(Number(backendUrl.port), backendUrl.hostname, () => {
    const requestLine = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n`;
    const forwardedHeaders = { ...req.headers, host: backendUrl.host };
    delete forwardedHeaders['x-admin-key'];
    if (adminKey) forwardedHeaders['x-admin-key'] = adminKey;
    const headers = Object.entries(forwardedHeaders)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
      .join('');
    upstream.write(`${requestLine}${headers}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(Number.isFinite(requestedPort) ? requestedPort : 0, '127.0.0.1', async () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Managed host did not bind a TCP port');
  if (portFile) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(portFile, `${address.port}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(`managed-host-ready:${address.port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
