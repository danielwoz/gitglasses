// The gitglasses-mcp npm package as published: its manifest, its files and
// the README npm shows. The repository README describes running the server
// from a clone; npm users get mcp-server/npm-readme.md instead.

/** Path of the npm README template, relative to the repository root. */
export const NPM_README_TEMPLATE = 'mcp-server/npm-readme.md';

/** Every file the published package contains. */
export const PACKAGE_FILES = ['LICENSE', 'README.md', 'dist/cli.js', 'package.json'];

/**
 * The manifest as published. The build scripts and the development
 * dependencies, which name unpublished workspace packages, mean nothing to
 * an npm user and are left out.
 */
export function publishedManifest(manifest) {
  const { scripts, devDependencies, ...published } = manifest;
  return published;
}

/** The npm README for `version`: the template without its leading comment, with the version filled in. */
export function renderNpmReadme(template, version) {
  return template.replace(/^<!--[\s\S]*?-->\s*/, '').replaceAll('{{version}}', version);
}

/** What would make `readme` wrong on the npm page of gitglasses-mcp `version`. */
export function npmReadmeProblems(readme, version) {
  const problems = [];
  if (readme.includes('{{') || readme.startsWith('<!--'))
    problems.push('README still has template markup');
  if (!readme.includes(`gitglasses-mcp@${version}`))
    problems.push(`README does not show how to run gitglasses-mcp@${version}`);
  if (/not on npm yet/i.test(readme)) problems.push('README says the package is not on npm');
  if (/git clone|pnpm (install|--filter)/.test(readme))
    problems.push('README tells readers to build from a clone');
  if (/\/path\/to\/gitglasses\/|mcp-server\/dist|build\/release/.test(readme)) {
    problems.push('README gives paths inside a clone');
  }
  return problems;
}
