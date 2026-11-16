import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTemplates, extractSubject } from '../src/templates.js';
import { makeDir, mjml } from './helpers.js';

test('extractSubject reads mj-title and decodes entities', () => {
  assert.equal(extractSubject(mjml('Welcome &amp; hello, {{name}}!')), 'Welcome & hello, {{name}}!');
  assert.equal(extractSubject(mjml(null)), null);
  assert.equal(extractSubject('<mjml><!-- <mj-title>x</mj-title> --></mjml>'), null);
});

test('mjml without yaml uses mj-title as subject and name', async () => {
  const dir = await makeDir({ 'welcome.mjml': mjml('Welcome!') });
  const { templates, errors } = await loadTemplates(dir);
  assert.deepEqual(errors, []);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].slug, 'welcome');
  assert.equal(templates[0].payload.name, 'Welcome!');
  assert.equal(templates[0].payload.subject, 'Welcome!');
  assert.equal(templates[0].payload.type, 'mjml');
});

test('mjml without yaml and without mj-title fails clearly', async () => {
  const dir = await makeDir({ 'welcome.mjml': mjml(null) });
  const { templates, errors } = await loadTemplates(dir);
  assert.equal(templates.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no subject and no name/);
  assert.match(errors[0].message, /welcome\.yaml/);
  assert.match(errors[0].file, /welcome\.mjml$/);
});

test('yaml fields are applied and schema is serialised', async () => {
  const dir = await makeDir({
    'emails/reset.mjml': mjml('ignored'),
    'emails/reset.yaml': `name: Password reset
subject: Reset your password
enabled: false
final: true
group: grp_123
snippet: false
schema:
  type: object
  properties:
    name: { type: string }
  required: [name]
`,
  });
  const { templates, errors } = await loadTemplates(dir);
  assert.deepEqual(errors, []);
  const { payload } = templates[0];
  assert.equal(payload.name, 'Password reset');
  assert.equal(payload.subject, 'Reset your password');
  assert.equal(payload.enabled, false);
  assert.equal(payload.final, true);
  assert.equal(payload.group, 'grp_123');
  assert.equal(payload.snippet, false);
  assert.deepEqual(JSON.parse(payload.schema), {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  });
});

test('schema given as JSON string is accepted', async () => {
  const dir = await makeDir({
    'a.mjml': mjml('A'),
    'a.yml': `schema: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}'\n`,
  });
  const { templates, errors } = await loadTemplates(dir);
  assert.deepEqual(errors, []);
  assert.equal(JSON.parse(templates[0].payload.schema).type, 'object');
});

const invalid = [
  ['discriminator', 'discriminator:\n  - { parameter: lang, cmp: eq, value: de }\n', /discriminator.*not supported/],
  ['invalid schema', 'schema:\n  type: banana\n', /not a valid JSON schema/],
  ['schema not JSON', 'schema: "{nope"\n', /not valid JSON/],
  ['unknown field', 'subject: x\nfoo: bar\n', /Unknown field `foo`/],
  ['wrong type', 'enabled: "yes"\n', /`enabled` must be `true` or `false`/],
  ['raw type', 'type: raw\n', /Only "mjml"/],
  ['slug', 'slug: other\n', /derived from the file name/],
  ['broken yaml', 'name: [unclosed\n', /Invalid YAML/],
];

for (const [label, yaml, expected] of invalid) {
  test(`rejects ${label}`, async () => {
    const dir = await makeDir({ 't.mjml': mjml('T'), 't.yaml': yaml });
    const { templates, errors } = await loadTemplates(dir);
    assert.equal(templates.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, expected);
    assert.match(errors[0].file, /t\.yaml$/);
    assert.ok(errors[0].line >= 1);
  });
}

test('reports line of offending key', async () => {
  const dir = await makeDir({ 't.mjml': mjml('T'), 't.yaml': 'name: ok\n\ndiscriminator: []\n' });
  const { errors } = await loadTemplates(dir);
  assert.equal(errors[0].line, 3);
});

test('yaml without mjml and duplicate slugs are errors', async () => {
  const dir = await makeDir({
    'orphan.yaml': 'name: x\n',
    'a/dup.mjml': mjml('A'),
    'b/dup.mjml': mjml('B'),
  });
  const { errors } = await loadTemplates(dir);
  const messages = errors.map((e) => e.message).join('\n');
  assert.match(messages, /no matching `orphan\.mjml`/);
  assert.match(messages, /Duplicate template slug "dup"/);
});

test('missing basePath throws', async () => {
  await assert.rejects(loadTemplates('/does/not/exist'), /does not exist/);
});
