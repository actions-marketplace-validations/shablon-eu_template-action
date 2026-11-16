import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Create a temp directory populated with `files` ({ relativePath: content }). */
export async function makeDir(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'shablon-action-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

export const mjml = (title) => `<mjml>
  <mj-head>${title ? `<mj-title>${title}</mj-title>` : ''}</mj-head>
  <mj-body><mj-section><mj-column><mj-text>Hi {{name}}</mj-text></mj-column></mj-section></mj-body>
</mjml>
`;
