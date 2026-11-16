import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncTemplate, buildUpdate } from '../src/sync.js';

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
  await assert.rejects(syncTemplate(client, template), /used by 2 templates.*discriminator/);
});
