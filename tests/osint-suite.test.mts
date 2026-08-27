import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyManagedOsintSuiteUrls,
  DEFAULT_OSINT_SUITE_URLS,
  loadOsintSuiteUrls,
  normalizeOsintToolUrl,
  OSINT_SUITE_STORAGE_KEY,
  saveOsintSuiteUrls,
} from '../src/services/osint-suite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

async function waitForTextFile(path: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe('OSINT Suite URL boundary', () => {
  it('accepts HTTPS and loopback HTTP while rejecting unsafe targets', () => {
    assert.equal(normalizeOsintToolUrl('https://intel.example.test/path/'), 'https://intel.example.test/path');
    assert.equal(normalizeOsintToolUrl('http://127.0.0.1:3101/'), 'http://127.0.0.1:3101');
    assert.equal(normalizeOsintToolUrl('http://localhost:3102'), 'http://localhost:3102');
    assert.equal(normalizeOsintToolUrl('http://192.168.1.5:3101'), null);
    assert.equal(normalizeOsintToolUrl('https://user:secret@example.test'), null);
    assert.equal(normalizeOsintToolUrl('javascript:alert(1)'), null);
  });

  it('fails closed per invalid stored value and preserves safe defaults', () => {
    const storage = {
      getItem(key: string) {
        assert.equal(key, OSINT_SUITE_STORAGE_KEY);
        return JSON.stringify({
          velocity: 'https://velocity.example.test/',
          ironsight: 'http://lan-device.test:3000',
          shadowbroker: 42,
        });
      },
    };
    assert.deepEqual(loadOsintSuiteUrls(storage), {
      velocity: 'https://velocity.example.test',
      ironsight: DEFAULT_OSINT_SUITE_URLS.ironsight,
      shadowbroker: DEFAULT_OSINT_SUITE_URLS.shadowbroker,
    });
  });

  it('normalizes every endpoint before persistence', () => {
    let stored = '';
    const storage = {
      setItem(key: string, value: string) {
        assert.equal(key, OSINT_SUITE_STORAGE_KEY);
        stored = value;
      },
    };
    assert.equal(saveOsintSuiteUrls({
      velocity: 'http://127.0.0.1:3101/',
      ironsight: 'https://ironsight.example.test/',
      shadowbroker: 'http://localhost:3103/',
    }, storage), true);
    assert.deepEqual(JSON.parse(stored), {
      velocity: 'http://127.0.0.1:3101',
      ironsight: 'https://ironsight.example.test',
      shadowbroker: 'http://localhost:3103',
    });
  });

  it('uses native managed ports only for untouched desktop defaults', () => {
    assert.deepEqual(applyManagedOsintSuiteUrls({
      velocity: DEFAULT_OSINT_SUITE_URLS.velocity,
      ironsight: 'https://ironsight.example.test',
      shadowbroker: DEFAULT_OSINT_SUITE_URLS.shadowbroker,
    }, {
      bundled: true,
      platform: 'windows-x86_64',
      tools: [
        { id: 'velocity', state: 'ready', url: 'http://127.0.0.1:43101' },
        { id: 'ironsight', state: 'ready', url: 'http://127.0.0.1:43102' },
        { id: 'shadowbroker', state: 'starting' },
      ],
    }), {
      velocity: 'http://127.0.0.1:43101',
      ironsight: 'https://ironsight.example.test',
      shadowbroker: DEFAULT_OSINT_SUITE_URLS.shadowbroker,
    });
  });

  it('rejects a non-loopback URL returned by the native runtime boundary', () => {
    assert.deepEqual(applyManagedOsintSuiteUrls({ ...DEFAULT_OSINT_SUITE_URLS }, {
      bundled: true,
      platform: 'windows-x86_64',
      tools: [
        { id: 'velocity', state: 'ready', url: 'http://192.168.1.7:9000' },
        { id: 'ironsight', state: 'failed', message: 'boom' },
        { id: 'shadowbroker', state: 'unavailable' },
      ],
    }), DEFAULT_OSINT_SUITE_URLS);
  });
});

describe('OSINT Suite deployment isolation', () => {
  const compose = readFileSync(resolve(repoRoot, 'docker-compose.osint-suite.yml'), 'utf8');
  const shadowbrokerNginx = readFileSync(
    resolve(repoRoot, 'docker/osint-suite/shadowbroker-nginx.conf'),
    'utf8',
  );

  it('publishes every integration endpoint on loopback only', () => {
    for (const port of [3101, 3102, 3103]) {
      assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${port}:`));
      assert.doesNotMatch(compose, new RegExp(`- ["']?${port}:`));
    }
  });

  it('keeps Shadowbroker backend and frontend off host ports', () => {
    const backendBlock = compose.match(/ {2}shadowbroker-backend:\n([\s\S]*?)\n {2}shadowbroker-frontend:/)?.[1] ?? '';
    const frontendBlock = compose.match(/ {2}shadowbroker-frontend:\n([\s\S]*?)\n {2}shadowbroker:/)?.[1] ?? '';
    assert.doesNotMatch(backendBlock, /\n\s+ports:/);
    assert.doesNotMatch(frontendBlock, /\n\s+ports:/);
  });

  it('limits the framing exception to loopback World Monitor origins', () => {
    assert.match(shadowbrokerNginx, /proxy_hide_header X-Frame-Options/);
    assert.match(shadowbrokerNginx, /proxy_hide_header Content-Security-Policy/);
    assert.match(
      shadowbrokerNginx,
      /frame-ancestors http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*/,
    );
    assert.doesNotMatch(shadowbrokerNginx, /frame-ancestors \*/);
  });
});

describe('managed Windows companion host', () => {
  it('serves the bundled UI on loopback and protects the backend admin header', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'wm-osint-host-'));
    const portFile = resolve(root, 'port.txt');
    writeFileSync(resolve(root, 'index.html'), '<h1>managed-suite</h1>');

    const backend = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        path: request.url,
        adminKey: request.headers['x-admin-key'],
      }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      backend.once('error', rejectListen);
      backend.listen(0, '127.0.0.1', resolveListen);
    });
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress !== 'string');

    const host = spawn(process.execPath, [resolve(repoRoot, 'src-tauri/osint-suite/managed-host.mjs')], {
      env: {
        ...process.env,
        OSINT_STATIC_ROOT: root,
        OSINT_BACKEND_URL: `http://127.0.0.1:${backendAddress.port}`,
        OSINT_HOST_PORT: '0',
        OSINT_PORT_FILE: portFile,
        OSINT_ADMIN_KEY: 'managed-only-key',
      },
      stdio: 'ignore',
    });

    try {
      const port = Number(await waitForTextFile(portFile));
      assert.ok(Number.isInteger(port) && port > 0);
      const ui = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(await ui.text(), '<h1>managed-suite</h1>');
      assert.match(ui.headers.get('content-security-policy') ?? '', /frame-ancestors/);

      const api = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { 'x-admin-key': 'attacker-controlled' },
      });
      assert.deepEqual(await api.json(), {
        path: '/api/health',
        adminKey: 'managed-only-key',
      });

      const adminSession = await fetch(`http://127.0.0.1:${port}/api/admin/session`);
      assert.deepEqual(await adminSession.json(), {
        ok: true,
        hasSession: true,
      });
    } finally {
      host.kill();
      await new Promise<void>((resolveClose) => backend.close(() => resolveClose()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
