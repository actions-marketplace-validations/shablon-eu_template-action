# Shablon Template Sync

A GitHub Action that creates or updates [Shablon](https://shablon.eu) email templates from MJML files in your repository.

```
templates/
├── welcome.mjml              → slug "welcome" (subject + name from <mj-title>)
├── password-reset.mjml       → slug "password-reset"
└── password-reset.yaml       → settings for "password-reset"
```

## Usage

```yaml
name: Deploy email templates

on:
  push:
    branches: [main]
    paths: ['templates/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: shablon-eu/template-action@v1
        with:
          apiKey: ${{ secrets.SHABLON_API_KEY }}
          basePath: templates
```

To check templates in pull requests without changing anything, set `dryRun: true`.

### Inputs

| Input      | Required | Default                  | Description                                                                 |
| ---------- | -------- | ------------------------ | --------------------------------------------------------------------------- |
| `apiKey`   | yes      |                          | Shablon API key (`sk.****`). Store it as a secret.                          |
| `basePath` | yes      |                          | Folder with the templates, relative to the repository root. Searched recursively. |
| `apiUrl`   | no       | `https://api.shablon.eu` | Base URL of the Shablon API.                                                |
| `dryRun`   | no       | `false`                  | Validate and report what would change, without creating or updating anything. |

### Outputs

| Output      | Description                                   |
| ----------- | --------------------------------------------- |
| `created`   | JSON array of slugs that were created.        |
| `updated`   | JSON array of slugs that were updated.        |
| `unchanged` | JSON array of slugs that were already up to date. |

## Template files

Every `<slug>.mjml` below `basePath` is one template. The **file name is the slug**, so slugs must be unique across all sub-folders and may only contain letters, digits, `-` and `_`.

### `<slug>.yaml` (optional)

Put a `<slug>.yaml` (or `.yml`) next to the MJML file to configure the template. Every field is optional:

```yaml
name: Password reset            # human-readable name (default: the subject)
subject: Reset your password    # email subject (default: the <mj-title> of the MJML file)
enabled: true                   # can the template be used to send?
final: false                    # prefer this template when several match
snippet: false                  # is this a reusable snippet?
group: grp_123                  # id of the group the template belongs to
type: mjml                      # only "mjml" is supported
schema:                         # JSON schema for the template parameters
  type: object
  properties:
    name: { type: string }
  required: [name]
```

- **`schema`** can be written as a YAML mapping (as above) or as a string containing JSON. It is validated as a JSON schema before anything is sent. Supported drafts are draft-07 (default), 2019-09 and 2020-12, picked by `$schema`.
- `enabled`, `final`, `snippet` and `group` are not touched if you leave them out when an existing template is updated. For example, if you toggle `enabled` in the Shablon UI and don't set it in the YAML file, the action leaves it as it is. `name` always has a value (it falls back to the subject), so it is always synced.
- `schema` is different: it belongs to the template content, like `subject` and the markup. If you remove it from the YAML file, the next sync publishes a new version without a schema.
- Unknown fields cause an error, so typos don't go unnoticed.

### Without a YAML file

If there is no YAML file, or it sets no `subject`, the subject comes from `<mj-title>` in `<mj-head>`. That subject is also used as the name unless `name` is set:

```xml
<mjml>
  <mj-head>
    <mj-title>Welcome, {{name}}!</mj-title>
  </mj-head>
  ...
</mjml>
```

If there is no subject in either place, the action fails and tells you which file to fix.

### Not supported (yet)

- **`discriminator` is not supported right now.** A YAML file that contains `discriminator` fails validation. Manage discriminators in the Shablon UI instead. For the same reason, if a slug already belongs to more than one template in Shablon (for example, discriminator variants), the action reports an error instead of guessing which one to update.
- Only `mjml` templates are supported. `raw` and `@react-email` are not.
- `slug` and `markup` cannot be set in YAML: they come from the file name and the `.mjml` file.

## Behaviour

1. **Validate everything first.** All templates are parsed and checked (YAML syntax, field types, JSON schema, subject present, unique slugs). If any template is invalid, the action fails **before** it calls the API, so nothing is partially deployed.
2. **Create or update.** For each template, the action looks up the slug in Shablon (snippets included):
   - not found: the template is **created** with that slug;
   - found: the template is **updated**, but only if something changed. Changes to `name`/`enabled`/`final`/`group`/`snippet` are sent on their own. Changes to `subject`/`markup`/`schema` create a new template version. Unchanged templates are skipped, so re-running the workflow doesn't create a new version each time.
3. **Report.** Errors show up as annotations on the offending file and line in the workflow run and in the PR "Files changed" view. A summary table is written to the job summary.

## Development

```sh
npm install
npm test        # unit + end-to-end tests (against a local fake API)
npm run build   # bundles src/ into dist/index.js – commit the result
```

`dist/` is committed because GitHub runs the action straight from the repository. CI fails if `dist/` is out of date.

### Releasing

Releases use [semantic versioning](https://semver.org). Commit (including a rebuilt `dist/`) and push a tag:

```sh
git tag -a v1.0.0 -m v1.0.0
git push origin v1.0.0
```

The [release workflow](.github/workflows/release.yml) then:

1. checks that `dist/` is up to date and the tests pass,
2. creates the GitHub release `v1.0.0` with generated release notes,
3. moves the floating tags **`v1.0`** and **`v1`** to the new release.

So users can pin `@v1` (all 1.x updates), `@v1.0` (patch updates only) or `@v1.0.0` (exact version).

A floating tag only moves if the new release is the newest in its line. A `v1.0.2` hotfix released after `v1.1.0` updates `v1.0`, but `v1` stays on `v1.1.0`. Pre-release tags such as `v1.1.0-rc.1` don't trigger the workflow.

To re-run it for an existing tag (for example, after a failed run), use **Actions → Release → Run workflow** and enter the tag.
