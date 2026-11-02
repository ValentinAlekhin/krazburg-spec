import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(projectDir, 'scripts/download-site.mjs');

async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Downloader did not exit within 25 seconds.\n${output}`));
    }, 25_000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output });
    });
  });
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'site-downloader-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startFixture(t, { missingAsset = false } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><head><title>Downloader fixture</title>
        <link rel="icon" href="/favicon.ico">
        <link rel="stylesheet" href="/asset.css?variant=one">
        <link rel="stylesheet" href="/asset.css?variant=two">
        </head><body><h1>Test constructor</h1><div id="result">Loading</div>
        ${missingAsset ? '<img src="/missing.png" alt="Missing asset">' : ''}
        <script type="module" src="/app.js"></script></body></html>`);
    } else if (url.pathname === '/app.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(`setTimeout(async () => {
        const [{ label }, data] = await Promise.all([
          import('./lazy.js'),
          fetch('/quote.json?room=one').then(response => response.json())
        ]);
        document.querySelector('#result').textContent = label + ': ' + data.total;
      }, 20);`);
    } else if (url.pathname === '/lazy.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end('export const label = "Calculated dynamically";');
    } else if (url.pathname === '/asset.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(`/* variant=${url.searchParams.get('variant')} */ body { color: #123; }`);
    } else if (url.pathname === '/quote.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ total: 1234, items: ['canvas', 'profile'] }));
    } else if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('fixture: resource does not exist');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}/`;
}

async function readJson(directory, filename) {
  return JSON.parse(await readFile(path.join(directory, filename), 'utf8'));
}

const captureArgs = (url, directory) => [
  '--url', url, '--out', directory, '--headless', '--duration', '0.3', '--timeout', '3000',
];

test('captures dynamic assets, distinct query URLs, JSON and rendered state', { timeout: 30_000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const url = await startFixture(t);
  const result = await run(captureArgs(url, directory));
  assert.equal(result.code, 0, result.output);
  const manifest = await readJson(directory, 'manifest.json');
  const summary = await readJson(directory, 'summary.json');
  assert.equal(summary.status, 'complete');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.sourceUrl, url);

  for (const pathname of ['/app.js', '/lazy.js', '/quote.json?room=one']) {
    const resource = manifest.resources.find((entry) => entry.url === new URL(pathname, url).href);
    assert.ok(resource, `Missing ${pathname}`);
    assert.equal(resource.captureStatus, 'saved');
    assert.equal(resource.status, 200);
  }
  const variants = manifest.resources.filter((entry) => new URL(entry.url).pathname === '/asset.css');
  assert.equal(variants.length, 2);
  assert.notEqual(variants[0].savedAs, variants[1].savedAs);
  assert.notEqual(
    await readFile(path.join(directory, variants[0].savedAs), 'utf8'),
    await readFile(path.join(directory, variants[1].savedAs), 'utf8'),
  );

  for (const resource of manifest.resources.filter((entry) => entry.captureStatus === 'saved')) {
    assert.equal(resource.method, 'GET');
    assert.ok(path.resolve(directory, resource.savedAs).startsWith(`${directory}${path.sep}`));
    const body = await readFile(path.join(directory, resource.savedAs));
    assert.equal(resource.bytes, body.length);
    assert.equal(resource.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal('headers' in resource, false);
    assert.equal('cookies' in resource, false);
  }
  assert.ok(manifest.states.length >= 1);
  const state = manifest.states.at(-1);
  assert.match(await readFile(path.join(directory, state.html), 'utf8'), /Calculated dynamically: 1234/);
  const screenshot = await readFile(path.join(directory, state.screenshot));
  assert.deepEqual(screenshot.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('retains a 404 response and marks the snapshot partial', { timeout: 30_000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const url = await startFixture(t, { missingAsset: true });
  const result = await run(captureArgs(url, directory));
  assert.equal(result.code, 2, result.output);
  assert.equal((await readJson(directory, 'summary.json')).status, 'partial');
  const manifest = await readJson(directory, 'manifest.json');
  const missing = manifest.resources.find((entry) => entry.url === new URL('/missing.png', url).href);
  assert.ok(missing);
  assert.equal(missing.status, 404);
  assert.equal(missing.captureStatus, 'saved');
  assert.equal(await readFile(path.join(directory, missing.savedAs), 'utf8'), 'fixture: resource does not exist');
});

test('connection failure writes diagnostics and a failed summary', { timeout: 30_000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const result = await run(captureArgs(`http://127.0.0.1:${port}/`, directory));
  assert.equal(result.code, 1, result.output);
  assert.equal((await readJson(directory, 'summary.json')).status, 'failed');
  const diagnostics = await readFile(path.join(directory, 'errors.jsonl'), 'utf8');
  assert.match(diagnostics, /ERR_CONNECTION_REFUSED|ECONNREFUSED|connection refused/i);
  await readJson(directory, 'manifest.json');
});

test('SIGINT during initial navigation gracefully preserves an interrupted snapshot', {
  timeout: 25_000,
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await temporaryDirectory(t);
  let requestObserved;
  const requested = new Promise((resolve) => { requestObserved = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/never.png') {
      requestObserved();
      // Keep the initial page's load event pending until the downloader exits.
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    // Leave the document stream open, so even DOMContentLoaded cannot finish.
    response.write('<!doctype html><h1>Navigation in progress</h1><img src="/never.png">');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const child = spawn(process.execPath, [script, '--url', url, '--out', directory,
    '--headless', '--timeout', '30000'], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let startupTimer;
  try {
    await Promise.race([
      requested,
      exited.then((result) => { throw new Error(`Downloader exited before navigation: ${JSON.stringify(result)}\n${output}`); }),
      new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error(`Navigation did not start.\n${output}`)), 8000); }),
    ]);
  } finally {
    clearTimeout(startupTimer);
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(child.kill('SIGINT'), true);
  let shutdownTimer;
  let result;
  try {
    result = await Promise.race([
      exited,
      new Promise((_, reject) => { shutdownTimer = setTimeout(() => reject(new Error(`SIGINT did not finish within 15 seconds.\n${output}`)), 15000); }),
    ]);
  } finally {
    clearTimeout(shutdownTimer);
  }
  assert.equal(result.signal, null, output);
  assert.equal(result.code, 2, output);
  const summary = await readJson(directory, 'summary.json');
  assert.equal(summary.status, 'partial');
  assert.equal(summary.interrupted, true);
  const manifest = await readJson(directory, 'manifest.json');
  assert.ok(manifest.finishedAt);
  assert.ok(manifest.resources.some((entry) => entry.url === new URL('/never.png', url).href));
});

test('rejects invalid arguments and preserves existing output files', { timeout: 30_000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const existing = path.join(directory, 'existing');
  await mkdir(existing);
  await writeFile(path.join(existing, 'sentinel.txt'), 'do not overwrite');
  const result = await run(captureArgs('http://127.0.0.1:1/', existing));
  assert.notEqual(result.code, 0, result.output);
  assert.equal(await readFile(path.join(existing, 'sentinel.txt'), 'utf8'), 'do not overwrite');
  assert.match(result.output, /не пуст|непуст|существ|empty|exist/i);

  const invalid = await run(['--url', 'file:///etc/passwd', '--headless']);
  assert.notEqual(invalid.code, 0, invalid.output);
  assert.match(invalid.output, /https?|протокол/i);
});
