import path from 'node:path';
import * as core from '@actions/core';
import { ShablonClient, ApiError } from './api.js';
import { TemplateError } from './errors.js';
import { loadTemplates, toTemplateError } from './templates.js';
import { syncTemplate } from './sync.js';

export async function run() {
  const apiKey = core.getInput('apiKey', { required: true });
  core.setSecret(apiKey);
  const basePathInput = core.getInput('basePath', { required: true });
  const apiUrl = core.getInput('apiUrl') || 'https://api.shablon.eu';
  const dryRun = core.getBooleanInput('dryRun');

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const basePath = path.resolve(workspace, basePathInput);

  core.info(`Looking for templates in ${basePath}${dryRun ? ' (dry run)' : ''}`);

  let loaded;
  try {
    loaded = await loadTemplates(basePath);
  } catch (err) {
    const e = toTemplateError(err);
    core.setFailed(e.message);
    return;
  }

  const { templates, errors: validationErrors } = loaded;

  if (templates.length === 0 && validationErrors.length === 0) {
    core.setFailed(`No templates found in ${basePathInput}. Expected files like \`<slug>.mjml\` (optionally with \`<slug>.yaml\`).`);
    return;
  }

  // Validate everything up front: if any template is invalid, don't push anything.
  if (validationErrors.length > 0) {
    for (const err of validationErrors) annotate(err, workspace);
    await writeSummary([], validationErrors, workspace, dryRun);
    core.setFailed(
      `${validationErrors.length} template${validationErrors.length === 1 ? ' is' : 's are'} invalid, nothing was synced. See the annotations above for details.`,
    );
    return;
  }

  core.info(`Found ${templates.length} template${templates.length === 1 ? '' : 's'}: ${templates.map((t) => t.slug).join(', ')}`);

  const client = new ShablonClient({ apiKey, apiUrl });
  const results = [];
  const syncErrors = [];

  for (const template of templates) {
    try {
      const result = await syncTemplate(client, template, { dryRun });
      results.push(result);
      const detail = result.changed.length ? ` (${result.changed.join(', ')})` : '';
      core.info(`${icon(result.action)} ${template.slug}: ${dryRun ? 'would be ' : ''}${result.action}${detail}`);
    } catch (err) {
      const e =
        err instanceof TemplateError
          ? err
          : new TemplateError(err instanceof ApiError ? err.message : String(err?.message ?? err), {
              slug: template.slug,
              file: template.configFile ?? template.mjmlFile,
            });
      syncErrors.push(e);
      annotate(e, workspace);
      // An invalid key will fail every request; stop early instead of spamming.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) break;
    }
  }

  const count = (action) => results.filter((r) => r.action === action).map((r) => r.slug);
  core.setOutput('created', JSON.stringify(count('created')));
  core.setOutput('updated', JSON.stringify(count('updated')));
  core.setOutput('unchanged', JSON.stringify(count('unchanged')));

  await writeSummary(results, syncErrors, workspace, dryRun);

  if (syncErrors.length > 0) {
    core.setFailed(`Failed to sync ${syncErrors.length} of ${templates.length} templates. See the annotations above for details.`);
  }
}

function icon(action) {
  return { created: '➕', updated: '🔄', unchanged: '✔️' }[action] ?? '•';
}

function relative(file, workspace) {
  return file ? path.relative(workspace, file).split(path.sep).join('/') : undefined;
}

/** Emit an `::error` annotation that GitHub shows inline on the file. */
function annotate(err, workspace) {
  const file = relative(err.file, workspace);
  core.error(err.message, {
    title: err.slug ? `Shablon template "${err.slug}"` : 'Shablon template',
    file,
    startLine: err.line ?? (file ? 1 : undefined),
    startColumn: err.column,
  });
}

async function writeSummary(results, errors, workspace, dryRun) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    const summary = core.summary.addHeading(`Shablon templates${dryRun ? ' (dry run)' : ''}`, 2);

    if (results.length > 0) {
      summary.addTable([
        [
          { data: 'Slug', header: true },
          { data: 'Result', header: true },
          { data: 'Changed fields', header: true },
          { data: 'Id', header: true },
        ],
        ...results.map((r) => [
          `<code>${escape(r.slug)}</code>`,
          `${icon(r.action)} ${r.action}`,
          escape(r.changed.join(', ') || '–'),
          escape(r.id),
        ]),
      ]);
    }

    if (errors.length > 0) {
      summary.addHeading(`❌ ${errors.length} error${errors.length === 1 ? '' : 's'}`, 3);
      summary.addTable([
        [
          { data: 'Template', header: true },
          { data: 'File', header: true },
          { data: 'Error', header: true },
        ],
        ...errors.map((e) => [
          e.slug ? `<code>${escape(e.slug)}</code>` : '–',
          escape(`${relative(e.file, workspace) ?? '–'}${e.line ? `:${e.line}` : ''}`),
          escape(e.message),
        ]),
      ]);
    }

    await summary.write();
  } catch (err) {
    core.warning(`Could not write job summary: ${err.message}`);
  }
}

function escape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
