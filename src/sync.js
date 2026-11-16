import { isDeepStrictEqual } from 'node:util';
import { TemplateError } from './errors.js';

const METADATA_FIELDS = ['name', 'enabled', 'final', 'group', 'snippet'];
const CONTENT_FIELDS = ['subject', 'type', 'markup', 'schema'];

/**
 * @typedef {'created' | 'updated' | 'unchanged'} SyncAction
 * @typedef {{ slug: string, action: SyncAction, id: string, changed: string[] }} SyncResult
 */

/**
 * Create or update a single template in Shablon.
 *
 * @param {import('./api.js').ShablonClient} client
 * @param {import('./templates.js').TemplateDefinition} template
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<SyncResult>}
 */
export async function syncTemplate(client, template, { dryRun = false } = {}) {
  const { slug, payload } = template;
  const existing = await client.findBySlug(slug);

  if (existing.length > 1) {
    throw new TemplateError(
      `Slug "${slug}" is used by ${existing.length} templates in Shablon (ids: ${existing.map((t) => t.id).join(', ')}). ` +
        'This usually means discriminator variants exist, which this action does not support. Resolve the duplicates in Shablon first.',
      { slug, file: template.mjmlFile },
    );
  }

  if (existing.length === 0) {
    if (dryRun) return { slug, action: 'created', id: '(dry run)', changed: Object.keys(payload) };
    const created = await client.createTemplate({ ...payload, slug });
    return { slug, action: 'created', id: created?.id ?? '', changed: Object.keys(payload) };
  }

  const [meta] = existing;
  const remote = await client.getTemplate(meta.id);
  const body = buildUpdate(payload, { ...meta, ...remote });
  const changed = Object.keys(body);

  if (changed.length === 0) {
    return { slug, action: 'unchanged', id: meta.id, changed };
  }
  if (!dryRun) {
    await client.updateTemplate(meta.id, body);
  }
  return { slug, action: 'updated', id: meta.id, changed: diffFields(payload, { ...meta, ...remote }) };
}

/**
 * Build a minimal PATCH body. Metadata fields are sent only when they differ.
 * If any content field differs, all content fields are sent together because
 * that creates a new template version (and the API requires subject + type).
 */
export function buildUpdate(local, remote) {
  const body = {};
  for (const key of METADATA_FIELDS) {
    if (local[key] !== undefined && !same(key, local[key], remote[key])) {
      body[key] = local[key];
    }
  }

  const contentChanged = CONTENT_FIELDS.some((key) => !same(key, local[key], remote[key]));
  if (contentChanged) {
    for (const key of CONTENT_FIELDS) {
      if (local[key] !== undefined) body[key] = local[key];
    }
  }
  return body;
}

function diffFields(local, remote) {
  return [...METADATA_FIELDS, ...CONTENT_FIELDS].filter(
    (key) => (local[key] !== undefined || CONTENT_FIELDS.includes(key)) && !same(key, local[key], remote[key]),
  );
}

function same(key, a, b) {
  if (key === 'schema') {
    return isDeepStrictEqual(parseSchema(a), parseSchema(b));
  }
  if (CONTENT_FIELDS.includes(key)) {
    return (a ?? '') === (b ?? '');
  }
  return a === b;
}

function parseSchema(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
