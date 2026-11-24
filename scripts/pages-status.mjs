// Run only by GitHub Actions. Report the one-time Pages setup without failing
// source validation when an owner has not enabled hosting yet.
import { appendFile } from 'node:fs/promises';

const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } = process.env;
if (!repository || !token || !output || !summary) throw new Error('This script is for the GitHub Actions workflow.');
const response = await fetch(`https://api.github.com/repos/${repository}/pages`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
});
if (!response.ok && ![403, 404].includes(response.status)) throw new Error(`Pages configuration lookup failed (${response.status})`);
const config = response.ok ? await response.json() : null;
const enabled = config?.build_type === 'workflow';
await appendFile(output, `enabled=${enabled}\n`);
if (enabled) {
  await appendFile(summary, '### FogLab build passed\n\nGitHub Pages uses GitHub Actions. Deployment will run next.\n');
} else {
  await appendFile(summary, `### FogLab build passed; hosting needs one-time setup\n\nThe source and offline build are ready. In [Settings → Pages](https://github.com/${repository}/settings/pages), select **GitHub Actions** as the publishing source. Then run this workflow again from the Actions tab. Future pushes to main deploy automatically.\n\nThe project inherits the account site’s custom domain. Leave the project’s custom-domain field empty.\n`);
}
console.log(enabled ? 'Pages is ready for deployment.' : 'Build is ready. Pages must be configured to use GitHub Actions.');
