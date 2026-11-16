import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { LineCounter, parseDocument, isMap, isScalar } from 'yaml';
import { TemplateError } from './errors.js';
import { validateJsonSchema } from './schema.js';

export const SUPPORTED_TYPES = ['mjml'];

/** Fields that can be configured through `<slug>.yaml`. */
export const CONFIG_FIELDS = {
  name: 'string',
  subject: 'string',
  enabled: 'boolean',
  final: 'boolean',
  group: 'string',
  snippet: 'boolean',
  schema: 'schema',
  type: 'type',
};

/** Fields that exist in the Shablon API but are deliberately not supported yet. */
const UNSUPPORTED_FIELDS = {
  discriminator:
    '`discriminator` is not supported by this action yet. Remove it from the YAML file and manage discriminators in the Shablon UI.',
  slug: 'The slug is derived from the file name (`<slug>.mjml`) and cannot be set in the YAML file. Rename the file instead.',
  markup: 'The markup is read from the `.mjml` file and cannot be set in the YAML file.',
  html: '`html` is only used by `raw` templates, which this action does not support (only `mjml`).',
  text: '`text` is only used by `raw` templates, which this action does not support (only `mjml`).',
};

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * @typedef {object} TemplateDefinition
 * @property {string} slug
 * @property {string} mjmlFile    absolute path of the .mjml file
 * @property {string|null} configFile absolute path of the .yaml/.yml file, if any
 * @property {object} payload     request body for the Shablon API (without slug)
 */

/**
 * Recursively find all template files below `basePath` and group them by slug.
 *
 * @param {string} basePath
 * @returns {Promise<Map<string, { mjml: string[], config: string[] }>>}
 */
export async function discoverTemplateFiles(basePath) {
  let info;
  try {
    info = await stat(basePath);
  } catch {
    throw new TemplateError(`basePath "${basePath}" does not exist.`);
  }
  if (!info.isDirectory()) {
    throw new TemplateError(`basePath "${basePath}" is not a directory.`);
  }

  const entries = await readdir(basePath, { recursive: true, withFileTypes: true });
  /** @type {Map<string, { mjml: string[], config: string[] }>} */
  const bySlug = new Map();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!['.mjml', '.yaml', '.yml'].includes(ext)) continue;

    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (full.split(path.sep).includes('node_modules')) continue;

    const slug = path.basename(entry.name, path.extname(entry.name));
    const group = bySlug.get(slug) ?? { mjml: [], config: [] };
    (ext === '.mjml' ? group.mjml : group.config).push(full);
    bySlug.set(slug, group);
  }

  return new Map([...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Discover and fully validate every template under `basePath`.
 * Never throws for per-template problems; those are collected in `errors`.
 *
 * @param {string} basePath
 * @returns {Promise<{ templates: TemplateDefinition[], errors: TemplateError[] }>}
 */
export async function loadTemplates(basePath) {
  const files = await discoverTemplateFiles(basePath);
  const templates = [];
  const errors = [];

  for (const [slug, group] of files) {
    try {
      templates.push(await loadTemplate(slug, group));
    } catch (err) {
      errors.push(toTemplateError(err, { slug, file: group.config[0] ?? group.mjml[0] }));
    }
  }

  return { templates, errors };
}

/**
 * @param {string} slug
 * @param {{ mjml: string[], config: string[] }} group
 * @returns {Promise<TemplateDefinition>}
 */
async function loadTemplate(slug, group) {
  if (group.mjml.length > 1) {
    throw new TemplateError(
      `Duplicate template slug "${slug}": found ${group.mjml.length} MJML files (${group.mjml.join(', ')}). Slugs must be unique across all sub-folders.`,
      { slug, file: group.mjml[1] },
    );
  }
  if (group.config.length > 1) {
    throw new TemplateError(
      `Multiple config files for template "${slug}" (${group.config.join(', ')}). Use exactly one \`${slug}.yaml\`.`,
      { slug, file: group.config[1] },
    );
  }

  const [mjmlFile] = group.mjml;
  const configFile = group.config[0] ?? null;

  if (!mjmlFile) {
    throw new TemplateError(
      `Found config file for "${slug}" but no matching \`${slug}.mjml\` next to it.`,
      { slug, file: configFile },
    );
  }
  if (configFile && path.dirname(configFile) !== path.dirname(mjmlFile)) {
    throw new TemplateError(
      `Config file for "${slug}" must be in the same folder as \`${slug}.mjml\` (${path.dirname(mjmlFile)}).`,
      { slug, file: configFile },
    );
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new TemplateError(
      `Invalid template slug "${slug}" (derived from the file name). Use only letters, digits, "-" and "_", starting with a letter or digit.`,
      { slug, file: mjmlFile },
    );
  }

  const markup = await readFile(mjmlFile, 'utf8');
  if (markup.trim() === '') {
    throw new TemplateError(`MJML file for "${slug}" is empty.`, { slug, file: mjmlFile, line: 1 });
  }

  const config = configFile ? parseConfig(await readFile(configFile, 'utf8'), { slug, file: configFile }) : {};
  const extracted = extractSubject(markup);

  const subject = config.subject ?? extracted;
  const name = config.name ?? subject;

  if (!subject) {
    const where = configFile
      ? `Add \`subject:\` to ${path.basename(configFile)} or an <mj-title> to ${path.basename(mjmlFile)}.`
      : `Add a \`${slug}.yaml\` with \`name:\` and \`subject:\`, or an <mj-title> inside <mj-head> of ${path.basename(mjmlFile)}.`;
    throw new TemplateError(
      `Template "${slug}" has no subject${config.name ? '' : ' and no name'}: ${where}`,
      { slug, file: configFile ?? mjmlFile, line: 1 },
    );
  }

  const payload = { name, subject, type: config.type ?? 'mjml', markup };
  for (const key of ['enabled', 'final', 'group', 'snippet', 'schema']) {
    if (config[key] !== undefined) payload[key] = config[key];
  }

  return { slug, mjmlFile, configFile, payload };
}

/**
 * Extract the subject from `<mj-title>` (MJML's equivalent of `<title>`).
 *
 * @param {string} markup
 * @returns {string|null}
 */
export function extractSubject(markup) {
  const withoutComments = markup.replace(/<!--[\s\S]*?-->/g, '');
  const head = withoutComments.match(/<mj-head\b[^>]*>([\s\S]*?)<\/mj-head>/i);
  const source = head ? head[1] : withoutComments;
  const title = source.match(/<mj-title\b[^>]*>([\s\S]*?)<\/mj-title>/i);
  if (!title) return null;
  const text = decodeEntities(title[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Parse and validate a `<slug>.yaml` config file.
 *
 * @param {string} source
 * @param {{ slug: string, file: string }} ctx
 */
export function parseConfig(source, ctx) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, prettyErrors: false });

  if (doc.errors.length > 0) {
    const [first] = doc.errors;
    const pos = first.linePos?.[0] ?? (first.pos ? lineCounter.linePos(first.pos[0]) : undefined);
    throw new TemplateError(`Invalid YAML: ${first.message.split('\n')[0]}`, {
      ...ctx,
      line: pos?.line,
      column: pos?.col,
    });
  }

  if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) {
    return {};
  }
  if (!isMap(doc.contents)) {
    throw new TemplateError('The YAML file must contain a mapping (key: value pairs) at the top level.', {
      ...ctx,
      line: 1,
    });
  }

  const json = doc.toJSON();
  const config = {};
  for (const pair of doc.contents.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const pos = pair.key?.range ? lineCounter.linePos(pair.key.range[0]) : undefined;
    const loc = { ...ctx, line: pos?.line, column: pos?.col };
    const value = json[key];

    if (key in UNSUPPORTED_FIELDS) {
      throw new TemplateError(UNSUPPORTED_FIELDS[key], loc);
    }
    const kind = CONFIG_FIELDS[key];
    if (!kind) {
      throw new TemplateError(
        `Unknown field \`${key}\`. Supported fields: ${Object.keys(CONFIG_FIELDS).join(', ')}.`,
        loc,
      );
    }
    config[key] = validateField(key, kind, value, loc);
  }

  return config;
}

function validateField(key, kind, value, loc) {
  switch (kind) {
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TemplateError(`\`${key}\` must be a non-empty string, got ${describe(value)}.`, loc);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new TemplateError(`\`${key}\` must be \`true\` or \`false\`, got ${describe(value)}.`, loc);
      }
      return value;
    case 'type':
      if (!SUPPORTED_TYPES.includes(value)) {
        throw new TemplateError(
          `\`type\` ${describe(value)} is not supported. Only ${SUPPORTED_TYPES.map((t) => `"${t}"`).join(', ')} is supported right now.`,
          loc,
        );
      }
      return value;
    case 'schema':
      return validateJsonSchema(value, loc);
    default:
      throw new Error(`unhandled field kind ${kind}`);
  }
}

function describe(value) {
  if (value === null || value === undefined) return 'an empty value';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * @param {unknown} err
 * @param {{ slug?: string, file?: string }} fallback
 * @returns {TemplateError}
 */
export function toTemplateError(err, fallback = {}) {
  if (err instanceof TemplateError) {
    err.slug ??= fallback.slug;
    err.file ??= fallback.file;
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new TemplateError(message, fallback);
}
