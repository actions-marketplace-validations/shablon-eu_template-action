/**
 * Discriminators decide which variant of a slug Shablon uses for a send.
 *
 * In YAML they are written as a mapping from send parameter to condition:
 *
 *   discriminator:
 *     lang: de                    # → { parameter: lang, cmp: eq, value: de }
 *     plan: [business, pro]       # → cmp: in
 *     age: { gte: 18, lt: 65 }    # → one rule per operator
 *
 * The Shablon API stores them as a list of `{ parameter, cmp, value }` rules
 * that must all match.
 */

/** Operators supported by the Shablon API. */
export const OPERATORS = ['eq', 'not', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'];
const LIST_OPERATORS = new Set(['in', 'not_in']);

/**
 * @typedef {{ parameter: string, cmp: string, value: string | number | string[] }} Rule
 */

/**
 * Turn the YAML condition for one parameter into API rules.
 * Throws a plain `Error` with a user-facing message on invalid input.
 *
 * @param {string} parameter
 * @param {unknown} condition
 * @returns {Rule[]}
 */
export function rulesForParameter(parameter, condition) {
  if (Array.isArray(condition)) {
    return [{ parameter, cmp: 'in', value: listValue(parameter, 'in', condition) }];
  }
  if (condition !== null && typeof condition === 'object') {
    const ops = Object.entries(condition);
    if (ops.length === 0) {
      throw new Error(`Condition for \`${parameter}\` is empty. Use a value (\`${parameter}: de\`), a list or operators like \`{ gte: 18 }\`.`);
    }
    return ops.map(([cmp, value]) => {
      if (!OPERATORS.includes(cmp)) {
        throw new Error(`Unknown operator \`${cmp}\` for \`${parameter}\`. Supported: ${OPERATORS.join(', ')}.`);
      }
      return {
        parameter,
        cmp,
        value: LIST_OPERATORS.has(cmp) ? listValue(parameter, cmp, value) : scalarValue(parameter, cmp, value),
      };
    });
  }
  return [{ parameter, cmp: 'eq', value: scalarValue(parameter, 'eq', condition) }];
}

function scalarValue(parameter, cmp, value) {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) {
    throw new Error(`\`${cmp}\` for \`${parameter}\` takes a single string or number. Use \`in\` / \`not_in\` for lists.`);
  }
  throw new Error(
    `\`${cmp}\` for \`${parameter}\` must be a string or a number, got ${describeValue(value)}. ` +
      (typeof value === 'boolean' ? `Shablon cannot compare booleans; quote it (\`"${value}"\`) if the parameter is a string.` : ''),
  );
}

function listValue(parameter, cmp, value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`\`${cmp}\` for \`${parameter}\` needs a non-empty list of strings, got ${describeValue(value)}.`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(
        `\`${cmp}\` for \`${parameter}\` only supports strings, got ${describeValue(item)}. Quote numbers (\`"5"\`) if the parameter is a string.`,
      );
    }
  }
  return value;
}

function describeValue(value) {
  if (value === null || value === undefined) return 'an empty value';
  if (Array.isArray(value)) return value.length === 0 ? 'an empty list' : 'a list';
  if (typeof value === 'object') return 'a mapping';
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Order-independent representation of a discriminator, used to compare a
 * local variant with a remote template. `undefined`, `null` and `[]` are all
 * "no discriminator" (catch-all).
 *
 * @param {Rule[] | null | undefined} rules
 */
export function canonicalDiscriminator(rules) {
  if (!Array.isArray(rules)) return '';
  return rules
    .map((r) => JSON.stringify([r.parameter, r.cmp, Array.isArray(r.value) ? [...r.value].sort() : r.value]))
    .sort()
    .join('\n');
}

/**
 * Could a single send match both discriminators? Returns `false` only when the
 * rules provably exclude each other (e.g. `lang: de` vs `lang: en`, or
 * `age: { lt: 18 }` vs `age: { gte: 18 }`); otherwise `true`.
 *
 * @param {Rule[]} a
 * @param {Rule[]} b
 */
export function canOverlap(a, b) {
  const all = [...a, ...b];
  const parameters = new Set(all.map((r) => r.parameter));
  for (const parameter of parameters) {
    if (unsatisfiable(all.filter((r) => r.parameter === parameter))) return false;
  }
  return true;
}

/** Can no single value satisfy all of `rules` (all for the same parameter)? */
function unsatisfiable(rules) {
  // Shablon compares with `==`, so 5 and "5" are the same value.
  const key = (v) => String(v);
  let allowed = null; // null = any value
  const excluded = new Set();
  let lo = -Infinity;
  let loIncl = true;
  let hi = Infinity;
  let hiIncl = true;
  let bounded = false;

  const intersect = (values) => {
    const next = new Set(values.map(key));
    allowed = allowed === null ? next : new Set([...allowed].filter((v) => next.has(v)));
  };

  for (const { cmp, value } of rules) {
    switch (cmp) {
      case 'eq':
        intersect([value]);
        break;
      case 'in':
        intersect(value);
        break;
      case 'not':
        excluded.add(key(value));
        break;
      case 'not_in':
        for (const v of value) excluded.add(key(v));
        break;
      default:
        // Only numeric bounds are understood; string comparisons are left alone.
        if (typeof value !== 'number') break;
        bounded = true;
        if (cmp === 'gt' && (value > lo || (value === lo && loIncl))) [lo, loIncl] = [value, false];
        if (cmp === 'gte' && value > lo) [lo, loIncl] = [value, true];
        if (cmp === 'lt' && (value < hi || (value === hi && hiIncl))) [hi, hiIncl] = [value, false];
        if (cmp === 'lte' && value < hi) [hi, hiIncl] = [value, true];
    }
  }

  const inBounds = (v) => {
    if (!bounded) return true;
    const n = Number(v);
    if (v === '' || Number.isNaN(n)) return false;
    return (n > lo || (n === lo && loIncl)) && (n < hi || (n === hi && hiIncl));
  };

  if (allowed !== null) {
    return ![...allowed].some((v) => !excluded.has(v) && inBounds(v));
  }
  return lo > hi || (lo === hi && !(loIncl && hiIncl));
}
