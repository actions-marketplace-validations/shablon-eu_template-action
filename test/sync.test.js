import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncTemplate, syncVariants, buildUpdate } from '../src/sync.js';

const template = {
  slug: 'welcome',
  mjmlFile: '/x/welcome.mjml',
  configFile: null,
  payload: { name: 'Welcome', subject: 'Hi', type: 'mjml', markup: '<mjml/>', enabled: true },
};

function fakeClient(existing = [], remote = {}) {
  const calls = [];
  return {
    calls,
    findBySlug: async (slug) => (calls.push(['find', slug]), existing),
    getTemplate: async (id) => (calls.push(['get', id]), remote),
    createTemplate: async (body) => (calls.push(['create', body]), { id: 'new1', slug: body.slug }),
    updateTemplate: async (id, body) => (calls.push(['update', id, body]), { id }),
    deleteTemplate: async (id) => (calls.push(['delete', id]), { id }),
  };
}

test('creates when slug is unknown', async () => {
  const client = fakeClient();
  const result = await syncTemplate(client, template);
  assert.equal(result.action, 'created');
  assert.deepEqual(client.calls[1], ['create', { ...template.payload, slug: 'welcome' }]);
});

test('updates when slug exists and content differs', async () => {
  const client = fakeClient([{ id: 't1', slug: 'welcome', name: 'Welcome', enabled: true }], {
    id: 't1', subject: 'Old', type: 'mjml', markup: '<mjml/>',
  });
  const result = await syncTemplate(client, template);
  assert.equal(result.action, 'updated');
  assert.deepEqual(result.changed, ['subject']);
  assert.deepEqual(client.calls.at(-1), ['update', 't1', { subject: 'Hi', type: 'mjml', markup: '<mjml/>' }]);
});

test('metadata-only change does not send content (no new version)', () => {
  const body = buildUpdate(
    { name: 'New', subject: 'Hi', type: 'mjml', markup: 'm' },
    { name: 'Old', subject: 'Hi', type: 'mjml', markup: 'm' },
  );
  assert.deepEqual(body, { name: 'New' });
});

test('schema comparison ignores JSON formatting', () => {
  const body = buildUpdate(
    { name: 'a', subject: 's', type: 'mjml', markup: 'm', schema: '{"type":"object"}' },
    { name: 'a', subject: 's', type: 'mjml', markup: 'm', schema: '{ "type": "object" }' },
  );
  assert.deepEqual(body, {});
});

test('unchanged template is not patched', async () => {
  const client = fakeClient([{ id: 't1', slug: 'welcome', name: 'Welcome', enabled: true }], {
    id: 't1', subject: 'Hi', type: 'mjml', markup: '<mjml/>',
  });
  const result = await syncTemplate(client, template);
  assert.equal(result.action, 'unchanged');
  assert.ok(!client.calls.some(([c]) => c === 'update'));
});

test('dry run does not write', async () => {
  const client = fakeClient();
  const result = await syncTemplate(client, template, { dryRun: true });
  assert.equal(result.action, 'created');
  assert.ok(!client.calls.some(([c]) => c === 'create'));
});

test('multiple templates with the same slug is an error', async () => {
  const client = fakeClient([{ id: 'a', slug: 'welcome' }, { id: 'b', slug: 'welcome' }]);
  await assert.rejects(syncTemplate(client, template), /used by 2 templates.*variants:/);
});

test('discriminator is compared ignoring rule order', () => {
  const de = { parameter: 'lang', cmp: 'eq', value: 'de' };
  const pro = { parameter: 'plan', cmp: 'in', value: ['a', 'b'] };
  const base = { name: 'a', subject: 's', type: 'mjml', markup: 'm' };
  assert.deepEqual(buildUpdate({ ...base, discriminator: [de, pro] }, { ...base, discriminator: [{ ...pro, value: ['b', 'a'] }, de] }), {});
  assert.deepEqual(buildUpdate({ ...base, discriminator: [] }, base), {});
  assert.deepEqual(buildUpdate({ ...base, discriminator: [de] }, base), { discriminator: [de] });
});

const content = { subject: 'S', type: 'mjml', markup: 'm' };
const DE = [{ parameter: 'lang', cmp: 'eq', value: 'de' }];
const variant = (key, payload) => ({ key, label: `welcome.${key}`, mjmlFile: `/x/welcome.${key}.mjml`, payload: { ...content, ...payload } });
const set = {
  slug: 'welcome',
  configFile: '/x/welcome.yaml',
  variants: [
    variant('de', { name: 'Welcome (de)', discriminator: DE }),
    variant('default', { name: 'Welcome (default)', discriminator: [] }),
  ],
};

function variantClient(existing) {
  const client = fakeClient(existing);
  client.getTemplate = async (id) => (client.calls.push(['get', id]), { ...existing.find((t) => t.id === id), ...content });
  return client;
}

test('variants: matched by discriminator first, then by name, else created', async () => {
  const client = variantClient([
    { id: 'r_default', slug: 'welcome', name: 'Old name', discriminator: undefined, enabled: true },
    { id: 'r_de', slug: 'welcome', name: 'Welcome (de)', discriminator: [{ parameter: 'lang', cmp: 'eq', value: 'at' }], enabled: true },
  ]);
  const results = await syncVariants(client, set);
  assert.deepEqual(
    results.map((r) => [r.slug, r.action, r.id, r.changed]),
    [
      ['welcome.de', 'updated', 'r_de', ['discriminator']],
      ['welcome.default', 'updated', 'r_default', ['name']],
    ],
  );
  assert.deepEqual(client.calls.filter(([c]) => c === 'update'), [
    ['update', 'r_de', { discriminator: DE }],
    ['update', 'r_default', { name: 'Welcome (default)' }],
  ]);
});

test('variants: missing variants are created with slug and discriminator', async () => {
  const client = variantClient([]);
  const results = await syncVariants(client, set);
  assert.deepEqual(results.map((r) => r.action), ['created', 'created']);
  const creates = client.calls.filter(([c]) => c === 'create').map(([, body]) => body);
  assert.deepEqual(creates.map((b) => [b.slug, b.discriminator]), [['welcome', DE], ['welcome', []]]);
});

const withOrphan = (enabled = true) => [
  { id: 'r_de', slug: 'welcome', name: 'Welcome (de)', discriminator: DE, enabled: true },
  { id: 'r_default', slug: 'welcome', name: 'Welcome (default)', enabled: true },
  { id: 'r_old', slug: 'welcome', name: 'Welcome (en)', discriminator: [{ parameter: 'lang', cmp: 'eq', value: 'en' }], enabled },
];

test('variants: orphan is disabled by default', async () => {
  const client = variantClient(withOrphan());
  const results = await syncVariants(client, set);
  assert.deepEqual(results.map((r) => [r.slug, r.action]), [
    ['welcome.de', 'unchanged'],
    ['welcome.default', 'unchanged'],
    ['welcome#r_old', 'disabled'],
  ]);
  assert.deepEqual(client.calls.filter(([c]) => c === 'update'), [['update', 'r_old', { enabled: false }]]);
});

test('variants: already disabled orphan is left alone', async () => {
  const client = variantClient(withOrphan(false));
  const results = await syncVariants(client, set);
  assert.equal(results[2].action, 'unchanged');
  assert.match(results[2].note, /already disabled/);
  assert.ok(!client.calls.some(([c]) => c === 'update'));
});

test('variants: prune delete and warn', async () => {
  let client = variantClient(withOrphan());
  let results = await syncVariants(client, set, { prune: 'delete' });
  assert.equal(results[2].action, 'deleted');
  assert.deepEqual(client.calls.filter(([c]) => c === 'delete'), [['delete', 'r_old']]);

  client = variantClient(withOrphan());
  results = await syncVariants(client, set, { prune: 'warn' });
  assert.equal(results[2].action, 'orphaned');
  assert.match(results[2].warning, /r_old.*can still be picked/);
  assert.ok(!client.calls.some(([c]) => c === 'update' || c === 'delete'));
});

test('variants: dry run does not prune', async () => {
  for (const prune of ['disable', 'delete']) {
    const client = variantClient(withOrphan());
    const results = await syncVariants(client, set, { prune, dryRun: true });
    assert.equal(results[2].action, prune === 'delete' ? 'deleted' : 'disabled');
    assert.ok(!client.calls.some(([c]) => c === 'update' || c === 'delete'));
  }
});

test('variants: ambiguous name match is an error', async () => {
  const client = variantClient([
    { id: 'a', slug: 'welcome', name: 'Welcome (de)', discriminator: [{ parameter: 'x', cmp: 'eq', value: '1' }] },
    { id: 'b', slug: 'welcome', name: 'Welcome (de)', discriminator: [{ parameter: 'x', cmp: 'eq', value: '2' }] },
  ]);
  await assert.rejects(syncVariants(client, set), /2 templates with slug "welcome" are named "Welcome \(de\)"/);
});
