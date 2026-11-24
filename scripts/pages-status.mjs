// Report the configured route without changing Pages settings. The artifact
// workflow deploys only in workflow mode; the branch workflow owns gh-pages.
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPagesConfiguration, requirePublicationBranch, usesPublicationBranch } from './publish-pages.mjs';

export function describePages({ status, config }) {
  if (status === 403) return { enabled: false, branchEnabled: false, message: 'Build passed. This workflow token cannot read the Pages configuration (HTTP 403); hosting status is unknown.' };
  if (status === 404) return { enabled: false, branchEnabled: false, message: 'Build passed. No accessible Pages configuration was found (HTTP 404). Review Settings → Pages; no hosting settings were changed.' };
  if (config?.build_type === 'workflow') return { enabled: true, branchEnabled: false, message: 'Build passed. Pages uses GitHub Actions; the artifact deployment job will run next.' };
  if (usesPublicationBranch(config)) return { enabled: false, branchEnabled: true, message: 'Build passed. Pages is configured for the gh-pages branch at /. The separate branch publication workflow requests the Pages build and verifies the live release.' };
  return { enabled: false, branchEnabled: false, message: 'Build passed. Pages has a different publishing source. Neither this artifact job nor the gh-pages publisher changes that configuration.' };
}

async function main() {
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } = process.env;
  if (!repository || !token || !output || !summary) throw new Error('This script is for the GitHub Actions workflow.');
  const result = await getPagesConfiguration({ repository, token });
  const status = describePages(result);
  await appendFile(output, `enabled=${status.enabled}\nbranch_enabled=${status.branchEnabled}\n`);
  await appendFile(summary, `### FogLab Pages configuration\n\n${status.message}\n`);
  console.log(status.message);
  if (process.argv.includes('--require-branch')) requirePublicationBranch(result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
