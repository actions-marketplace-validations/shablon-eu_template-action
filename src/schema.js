import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { TemplateError } from './errors.js';

const DRAFTS = [
  { match: /draft-07\/schema/, label: 'draft-07', create: () => new Ajv(options()) },
  { match: /2019-09\/schema/, label: '2019-09', create: () => new Ajv2019(options()) },
  { match: /2020-12\/schema/, label: '2020-12', create: () => new Ajv2020(options()) },
];

function options() {
  // strict mode would reject perfectly valid-but-unknown keywords (e.g. `example`),
  // which we don't want to enforce on users.
  return { strict: false, allErrors: true, validateFormats: false };
}

/**
 * Validate that `value` is a JSON schema and return it as a JSON string,
 * which is what the Shablon API expects.
 *
 * `value` may be a YAML mapping (already parsed to an object) or a string
 * containing JSON.
 *
 * @param {unknown} value
 * @param {{ file?: string, line?: number, column?: number, slug?: string }} loc
 * @returns {string}
 */
export function validateJsonSchema(value, loc) {
  let schema = value;

  if (typeof schema === 'string') {
    try {
      schema = JSON.parse(schema);
    } catch (err) {
      throw new TemplateError(`\`schema\` is a string but not valid JSON: ${err.message}`, loc);
    }
  }

  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TemplateError(
      '`schema` must be a JSON schema object (either as a YAML mapping or as a JSON string).',
      loc,
    );
  }

  const declared = typeof schema.$schema === 'string' ? schema.$schema : undefined;
  let draft = DRAFTS[0];
  if (declared) {
    draft = DRAFTS.find((d) => d.match.test(declared));
    if (!draft) {
      throw new TemplateError(
        `\`schema\` declares unsupported $schema "${declared}". Supported: ${DRAFTS.map((d) => d.label).join(', ')} (default: draft-07).`,
        loc,
      );
    }
  }

  const ajv = draft.create();
  if (!ajv.validateSchema(schema)) {
    const details = ajv.errors
      .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ');
    throw new TemplateError(`\`schema\` is not a valid JSON schema (${draft.label}): ${details}`, loc);
  }

  try {
    ajv.compile(schema);
  } catch (err) {
    throw new TemplateError(`\`schema\` could not be compiled: ${err.message}`, loc);
  }

  return JSON.stringify(schema);
}
