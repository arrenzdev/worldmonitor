#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const bundleRoot = join(repoRoot, 'src-tauri', 'osint-suite');
const runtimeRoot = join(bundleRoot, 'runtime');
const manifestPath = join(bundleRoot, 'bundle-manifest.json');
const workRoot = join(repoRoot, 'tmp', 'osint-suite-build');
const args = new Set(process.argv.slice(2));
const planOnly = args.has('--plan');
const clean = args.has('--clean');
const skipPlaywright = args.has('--skip-playwright');
const platformArgIndex = process.argv.indexOf('--platform');
const platform = platformArgIndex >= 0 ? process.argv[platformArgIndex + 1] : 'windows-x64';

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const shaPattern = /^[0-9a-f]{40}$/;

function fail(message) {
  console.error(`[osint-suite-runtime] ${message}`);
  process.exit(1);
}

function assertManifest() {
  if (manifest.schema !== 'worldmonitor-osint-suite-bundle/v1') fail('Unsupported manifest schema');
  if (manifest.platform !== 'windows-x64') fail(`Unsupported manifest platform: ${manifest.platform}`);
  if (platform !== manifest.platform) fail(`Requested ${platform}, manifest targets ${manifest.platform}`);
  for (const [name, upstream] of Object.entries(manifest.upstreams ?? {})) {
    if (!upstream || typeof upstream.repository !== 'string' || !upstream.repository.startsWith('https://github.com/')) {
      fail(`${name}: repository must be an HTTPS GitHub URL`);
    }
    if (!shaPattern.test(upstream.commit ?? '')) fail(`${name}: commit must be a full 40-character SHA`);
  }
  for (const required of ['velocity', 'ironsight', 'shadowbroker']) {
    if (!manifest.upstreams?.[required]) fail(`Missing ${required} upstream pin`);
  }
}

function commandText(command, commandArgs) {
  return [command, ...commandArgs].map((value) => JSON.stringify(value)).join(' ');
}

function run(command, commandArgs, options = {}) {
  console.log(`[osint-suite-runtime] ${commandText(command, commandArgs)}`);
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: 'inherit',
    shell: process.platform === 'win32' && ['npm', 'npx', 'corepack', 'cargo'].includes(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function clonePinned(name) {
  const upstream = manifest.upstreams[name];
  const destination = join(workRoot, name);
  rmSync(destination, { recursive: true, force: true });
  run('git', ['clone', '--filter=blob:none', '--no-checkout', upstream.repository, destination]);
  run('git', ['-C', destination, 'fetch', '--depth', '1', 'origin', upstream.commit]);
  run('git', ['-C', destination, 'checkout', '--detach', upstream.commit]);
  const actual = execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actual !== upstream.commit) throw new Error(`${name}: checkout mismatch ${actual}`);
  return destination;
}

function copyTree(source, destination, filter = () => true) {
  if (!existsSync(source)) throw new Error(`Missing source tree: ${source}`);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    filter(sourcePath) {
      const rel = relative(source, sourcePath).split(sep).join('/');
      return !rel || filter(rel, sourcePath);
    },
  });
}

function countFiles(root) {
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(root, entry.name)) : 1;
  }
  return count;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function pythonExecutable() {
  const explicit = process.env.PYTHON;
  if (explicit) return explicit;
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function stagePortablePython(velocityDir, shadowbrokerDir) {
  if (process.platform !== 'win32') {
    throw new Error('The managed runtime must be assembled on a Windows x64 runner');
  }
  const systemPython = pythonExecutable();
  const basePrefix = execFileSync(systemPython, ['-c', 'import sys; print(sys.base_prefix)'], { encoding: 'utf8' }).trim();
  const destination = join(runtimeRoot, 'python');
  copyTree(basePrefix, destination, (rel) => {
    const normalized = rel.toLowerCase();
    return !normalized.startsWith('lib/site-packages/')
      && normalized !== 'lib/site-packages'
      && !normalized.startsWith('include/')
      && normalized !== 'include'
      && !normalized.startsWith('libs/')
      && normalized !== 'libs'
      && !normalized.includes('/__pycache__/')
      && !normalized.endsWith('.pyc');
  });
  const sitePackages = join(destination, 'Lib', 'site-packages');
  mkdirSync(sitePackages, { recursive: true });

  run(systemPython, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile',
    '--target', sitePackages,
    join(velocityDir, 'apps', 'api'),
    join(shadowbrokerDir, 'backend'),
  ]);

  if (!skipPlaywright) {
    const browserRoot = join(destination, 'playwright-browsers');
    run(systemPython, ['-m', 'playwright', 'install', 'chromium'], {
      env: {
        PYTHONPATH: sitePackages,
        PLAYWRIGHT_BROWSERS_PATH: browserRoot,
      },
    });
  }

  const bundledPython = join(destination, 'python.exe');
  run(bundledPython, ['-c', 'import fastapi, uvicorn, httpx, pydantic; print("portable-python-ok")'], {
    env: { PYTHONPATH: sitePackages },
  });
  return destination;
}

function stageVelocity(source) {
  run('corepack', ['pnpm', 'install', '--frozen-lockfile'], { cwd: source });
  run('corepack', ['pnpm', '--filter', '@osint/web', 'build'], { cwd: source });
  run('npm', ['ci', '--omit=dev', '--ignore-scripts'], {
    cwd: join(source, 'tools', 'adsb-globe-feeder'),
    env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  });

  const destination = join(runtimeRoot, 'velocity');
  mkdirSync(destination, { recursive: true });
  copyTree(join(source, 'apps', 'api', 'app'), join(destination, 'apps', 'api', 'app'), (rel) => {
    return !rel.includes('/__pycache__/') && !rel.endsWith('.pyc');
  });
  copyTree(join(source, 'apps', 'web', 'dist'), join(destination, 'apps', 'web', 'dist'));
  copyTree(join(source, 'apps', 'ml', 'fusion'), join(destination, 'apps', 'ml', 'fusion'), (rel) => {
    return !rel.startsWith('.mamba') && !rel.includes('/__pycache__/') && !rel.endsWith('.pyc');
  });
  copyTree(join(source, 'tools'), join(destination, 'tools'), (rel) => {
    return !rel.includes('/__pycache__/') && !rel.endsWith('.pyc');
  });
  cpSync(join(source, 'LICENSE'), join(destination, 'LICENSE'));
}

function stageIronsight(source) {
  run('npm', ['ci'], { cwd: source });
  run('npm', ['run', 'build'], { cwd: source, env: { NEXT_TELEMETRY_DISABLED: '1' } });
  const destination = join(runtimeRoot, 'ironsight');
  copyTree(join(source, '.next', 'standalone'), destination);
  mkdirSync(join(destination, '.next'), { recursive: true });
  copyTree(join(source, '.next', 'static'), join(destination, '.next', 'static'));
  if (existsSync(join(source, 'public'))) copyTree(join(source, 'public'), join(destination, 'public'));
  cpSync(join(source, 'LICENSE'), join(destination, 'LICENSE'));
}

function stageShadowbroker(source) {
  const frontend = join(source, 'frontend');
  const backend = join(source, 'backend');
  run('npm', ['ci'], { cwd: frontend });
  run('npm', ['run', 'build:privacy-core-wasm'], { cwd: frontend });
  run('node', [join(source, 'desktop-shell', 'tauri-skeleton', 'scripts', 'build-frontend-export.cjs')], { cwd: source });
  run('npm', ['ci', '--omit=dev'], { cwd: backend });
  run('cargo', ['build', '--release', '--manifest-path', join(source, 'privacy-core', 'Cargo.toml')], { cwd: source });

  const destination = join(runtimeRoot, 'shadowbroker');
  mkdirSync(destination, { recursive: true });
  copyTree(join(frontend, 'out'), join(destination, 'web'));
  copyTree(backend, join(destination, 'backend'), (rel) => {
    const segments = rel.split('/');
    return !segments.some((part) => ['.pytest_cache', '.ruff_cache', '__pycache__', 'tests', 'venv', '.venv'].includes(part))
      && !rel.endsWith('.pyc')
      && rel !== '.env';
  });
  const privacyDll = join(source, 'privacy-core', 'target', 'release', 'privacy_core.dll');
  if (!existsSync(privacyDll)) throw new Error(`privacy_core.dll missing at ${privacyDll}`);
  cpSync(privacyDll, join(destination, 'backend', 'privacy_core.dll'));
  cpSync(join(source, 'LICENSE'), join(destination, 'LICENSE'));
}

function writeRuntimeManifest() {
  const critical = [
    'python/python.exe',
    'velocity/apps/api/app/main.py',
    'velocity/apps/web/dist/index.html',
    'velocity/tools/adsb-globe-feeder/node_modules/playwright/package.json',
    'ironsight/server.js',
    'shadowbroker/backend/main.py',
    'shadowbroker/backend/privacy_core.dll',
    'shadowbroker/web/index.html',
  ];
  const checksums = {};
  for (const relativePath of critical) {
    const absolute = join(runtimeRoot, ...relativePath.split('/'));
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`Critical runtime asset missing: ${relativePath}`);
    }
    checksums[relativePath] = sha256(absolute);
  }
  const output = {
    ...manifest,
    generatedAt: new Date().toISOString(),
    fileCount: countFiles(runtimeRoot),
    checksums,
  };
  writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), `${JSON.stringify(output, null, 2)}\n`);
}

function printPlan() {
  console.log(JSON.stringify({
    schema: manifest.schema,
    bundleVersion: manifest.bundleVersion,
    platform,
    output: relative(repoRoot, runtimeRoot),
    upstreams: Object.fromEntries(
      Object.entries(manifest.upstreams).map(([name, value]) => [name, `${basename(value.repository, '.git')}@${value.commit}`]),
    ),
    runtime: ['bundled Python 3.12', 'World Monitor bundled Node.js', 'Velocity FastAPI + Vite', 'IRONSIGHT Next standalone', 'Shadowbroker FastAPI + static companion host'],
  }, null, 2));
}

assertManifest();
printPlan();
if (planOnly) process.exit(0);
if (process.platform !== 'win32' || process.arch !== 'x64') {
  fail(`Full assembly requires Windows x64; current host is ${process.platform}-${process.arch}. Use --plan elsewhere.`);
}

try {
  if (clean) rmSync(workRoot, { recursive: true, force: true });
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(workRoot, { recursive: true });

  const velocity = clonePinned('velocity');
  const ironsight = clonePinned('ironsight');
  const shadowbroker = clonePinned('shadowbroker');

  stagePortablePython(velocity, shadowbroker);
  stageVelocity(velocity);
  stageIronsight(ironsight);
  stageShadowbroker(shadowbroker);
  writeRuntimeManifest();
  console.log(`[osint-suite-runtime] ready: ${countFiles(runtimeRoot)} files at ${runtimeRoot}`);
} catch (error) {
  console.error(`[osint-suite-runtime] build failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
}
