import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_OSINT_SUITE_URLS,
  loadOsintSuiteUrls,
  normalizeOsintToolUrl,
  OSINT_SUITE_STORAGE_KEY,
  saveOsintSuiteUrls,
} from '../src/services/osint-suite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

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
