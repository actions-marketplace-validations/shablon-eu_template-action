import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDir, mjml } from './helpers.js';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

// In-memory fake of the Shablon templates API.
const store = new Map();
const requests = [];
let server;
let apiUrl;

before(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== 'Bearer sk.test') return send(403, { delivery: 'failed', reason: 'invalid api key' });

    if (req.method === 'GET' && url.pathname === '/v1/templates') {
      const snippet = url.searchParams.get('snippet') === 'true';
      const data = [...store.values()].filter(
        (t) => t.slug === url.searchParams.get('slug') && Boolean(t.snippet) === snippet,
      );
      return send(200, { data, nextCursor: null, isDone: true });
    }
    if (req.method === 'POST' && url.pathname === '/v1/templates') {
      const id = `id_${store.size + 1}`;
      store.set(id, { id, ...body });
      return send(200, { id, slug: body.slug });
    }
    const m = url.pathname.match(/^\/v1\/templates\/(.+)$/);
    if (m && store.has(m[1])) {
      if (req.method === 'GET') return send(200, store.get(m[1]));
      if (req.method === 'PATCH') {
        Object.assign(store.get(m[1]), body);
        return send(200, { id: m[1] });
      }
    }
    send(404, { error: 'template not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function runAction(files, inputs = {}) {
  const workspace = await makeDir(files);
  const summaryFile = path.join(workspace, 'summary.md');
  await writeFile(summaryFile, ''); // GitHub pre-creates this file
  const child = spawn(process.execPath, [dist], {
    env: {
      PATH: process.env.PATH,
      GITHUB_WORKSPACE: workspace,
      GITHUB_STEP_SUMMARY: summaryFile,
      INPUT_APIKEY: 'sk.test',
      INPUT_BASEPATH: 'templates',
      INPUT_APIURL: apiUrl,
      INPUT_DRYRUN: 'false',
      ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const status = await new Promise((r) => child.on('close', r));
  const proc = { status, stdout, stderr };
  const summary = await readFile(summaryFile, 'utf8').catch(() => '');
  return { ...proc, summary };
}

test('creates, then leaves unchanged, then updates', async () => {
  const files = {
    'templates/welcome.mjml': mjml('Welcome!'),
    'templates/reset.mjml': mjml(null),
    'templates/reset.yaml': 'name: Reset\nsubject: Reset password\nschema:\n  type: object\n',
  };

  let r = await runAction(files);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /welcome: created/);
  assert.match(r.stdout, /reset: created/);
  assert.match(r.summary, /created/);
  assert.equal(store.size, 2);

  r = await runAction(files);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /welcome: unchanged/);
  assert.match(r.stdout, /reset: unchanged/);

  r = await runAction({ ...files, 'templates/welcome.mjml': mjml('Welcome back!') });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /welcome: updated \(name, subject, markup\)/);
  const patch = requests.filter((q) => q.method === 'PATCH').at(-1);
  assert.deepEqual(Object.keys(patch.body).sort(), ['markup', 'name', 'subject', 'type']);
});

test('validation errors fail with file annotations and nothing is synced', async () => {
  const before = requests.length;
  const r = await runAction({
    'templates/ok.mjml': mjml('OK'),
    'templates/nosubject.mjml': mjml(null),
    'templates/variant.mjml': mjml('V'),
    'templates/variant.yaml': 'name: V\ndiscriminator: []\n',
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error title=Shablon template "nosubject",file=templates\/nosubject\.mjml,line=1::/);
  assert.match(r.stdout, /::error title=Shablon template "variant",file=templates\/variant\.yaml,line=2,col=1::`discriminator` is not supported/);
  assert.match(r.stdout, /2 templates are invalid, nothing was synced/);
  assert.match(r.summary, /2 errors/);
  assert.equal(requests.length, before, 'no API requests on validation failure');
});

test('invalid api key fails clearly', async () => {
  const r = await runAction({ 'templates/x.mjml': mjml('X') }, { apiKey: 'sk.wrong' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /invalid API key/);
});
