import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { TemplateError } from './errors.js';
import { canonicalDiscriminator } from './discriminator.js';

const METADATA_FIELDS = ['name', 'enabled', 'final', 'group', 'snippet', 'discriminator'];
const CONTENT_FIELDS = ['subject', 'type', 'markup', 'schema'];

export const PRUNE_MODES = ['disable', 'delete', 'warn'];

/**
 * @typedef {'created' | 'updated' | 'unchanged' | 'disabled' | 'deleted' | 'orphaned'} SyncAction
 * @typedef {object} SyncResult
 * @property {string} slug      what is reported: `<slug>`, `<slug>.<variant>` or `<slug>#<id>` for a pruned template
 * @property {SyncAction} action
 * @property {string} id
 * @property {string[]} changed
 * @property {string} [note]    extra detail for logs and the summary
 * @property {string} [warning] set for orphaned templates when `prune: warn`
 */

/**
 * Sync a template or a variant set.
 *
 * @param {import('./api.js').ShablonClient} client
 * @param {import('./templates.js').TemplateDefinition | import('./templates.js').VariantSetDefinition} definition
 * @param {{ dryRun?: boolean, prune?: 'disable' | 'delete' | 'warn' }} [options]
 * @returns {Promise<SyncResult[]>}
 */
export function syncDefinition(client, definition, options) {
  return definition.variants ? syncVariants(client, definition, options) : syncTemplate(client, definition, options).then((r) => [r]);
}

/**
 * Create or update a single template (no `variants:`) in Shablon.
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
        `If these are discriminator variants, declare them under \`variants:\` in \`${slug}.yaml\` so the action knows which file belongs to which template.`,
      { slug, file: template.configFile ?? template.mjmlFile },
    );
  }

  return upsert(client, slug, slug, payload, existing[0], dryRun);
}

/**
 * Sync all variants of a slug. Each local variant is matched to a remote
 * template with the same slug:
 *
 * 1. by identical discriminator (rule order doesn't matter),
 * 2. otherwise by identical name, so editing a variant's rules keeps its history,
 * 3. otherwise a new template is created.
 *
 * Remote templates with the slug that match no variant are pruned.
 *
 * @param {import('./api.js').ShablonClient} client
 * @param {import('./templates.js').VariantSetDefinition} set
 * @param {{ dryRun?: boolean, prune?: 'disable' | 'delete' | 'warn' }} [options]
 * @returns {Promise<SyncResult[]>}
 */
export async function syncVariants(client, set, { dryRun = false, prune = 'disable' } = {}) {
  const { slug, configFile } = set;
  const existing = await client.findBySlug(slug);
  const { matches, orphans } = matchVariants(set, existing);

  const results = [];
  for (const variant of set.variants) {
    results.push(await upsert(client, slug, variant.label, variant.payload, matches.get(variant.key), dryRun));
  }

  const yamlName = path.basename(configFile);
  for (const orphan of orphans) {
    const label = `${slug}#${orphan.id}`;
    const what = `"${orphan.name ?? orphan.id}" is not a variant in ${yamlName}`;

    if (prune === 'warn') {
      results.push({
        slug: label,
        action: 'orphaned',
        id: orphan.id,
        changed: [],
        note: what,
        warning:
          `Template ${orphan.id} ("${orphan.name ?? ''}") has slug "${slug}" but matches no variant in ${yamlName}. ` +
          `It is left as it is${orphan.enabled === false ? '' : ' and can still be picked for sends'} (prune: warn).`,
      });
    } else if (prune === 'delete') {
      if (!dryRun) await client.deleteTemplate(orphan.id);
      results.push({ slug: label, action: 'deleted', id: orphan.id, changed: [], note: what });
    } else if (orphan.enabled === false) {
      results.push({ slug: label, action: 'unchanged', id: orphan.id, changed: [], note: `${what}, already disabled` });
    } else {
      if (!dryRun) await client.updateTemplate(orphan.id, { enabled: false });
      results.push({ slug: label, action: 'disabled', id: orphan.id, changed: ['enabled'], note: what });
    }
  }
  return results;
}

/**
 * @param {import('./templates.js').VariantSetDefinition} set
 * @param {any[]} existing remote template metadata with this slug
 */
export function matchVariants(set, existing) {
  const unclaimed = [...existing];
  /** @type {Map<string, any>} */
  const matches = new Map();
  const claim = (key, remote) => {
    matches.set(key, remote);
    unclaimed.splice(unclaimed.indexOf(remote), 1);
  };

  for (const variant of set.variants) {
    const canonical = canonicalDiscriminator(variant.payload.discriminator);
    const remote = unclaimed.find((t) => canonicalDiscriminator(t.discriminator) === canonical);
    if (remote) claim(variant.key, remote);
  }

  for (const variant of set.variants) {
    if (matches.has(variant.key)) continue;
    const byName = unclaimed.filter((t) => t.name === variant.payload.name);
    if (byName.length > 1) {
      throw new TemplateError(
        `Cannot tell which template variant "${variant.key}" belongs to: its discriminator matches none in Shablon, ` +
          `and ${byName.length} templates with slug "${set.slug}" are named "${variant.payload.name}" (ids: ${byName.map((t) => t.id).join(', ')}). ` +
          'Rename or remove the duplicates in Shablon.',
        { slug: set.slug, file: set.configFile },
      );
    }
    if (byName.length === 1) claim(variant.key, byName[0]);
  }

  return { matches, orphans: unclaimed };
}

async function upsert(client, slug, label, payload, meta, dryRun) {
  if (!meta) {
    if (dryRun) return { slug: label, action: 'created', id: '(dry run)', changed: Object.keys(payload) };
    const created = await client.createTemplate({ ...payload, slug });
    return { slug: label, action: 'created', id: created?.id ?? '', changed: Object.keys(payload) };
  }

  const remote = { ...meta, ...(await client.getTemplate(meta.id)) };
  const body = buildUpdate(payload, remote);

  if (Object.keys(body).length === 0) {
    return { slug: label, action: 'unchanged', id: meta.id, changed: [] };
  }
  if (!dryRun) {
    await client.updateTemplate(meta.id, body);
  }
  return { slug: label, action: 'updated', id: meta.id, changed: diffFields(payload, remote) };
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
  if (key === 'discriminator') {
    return canonicalDiscriminator(a) === canonicalDiscriminator(b);
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
