# Releasing GitGlasses

A release is a `v*` tag on a commit of `main`. `.github/workflows/release.yml`
then:

1. checks that the tag, `extension/package.json`, `mcp-server/package.json`,
   the root `package.json`, the engine's CMake version and
   `extension/CHANGELOG.md` agree, and that the tagged commit is on `main`;
2. builds the engine for every platform (Linux, Alpine, macOS and Windows on
   x64 and arm64, plus WebAssembly), runs its tests, strips it, keeps the
   symbols, and runs the binary;
3. packages nine VSIXes (`linux-x64`, `linux-arm64`, `alpine-x64`,
   `alpine-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`,
   `web`), refusing an engine whose format or CPU does not match the target,
   and runs each packaged engine, and the MCP server bundled with it, on its
   own platform;
4. packs `gitglasses-mcp`, with `mcp-server/npm-readme.md` as the README
   npm shows, and one engine package per engine build
   (`@gitglasses/engine-linux-x64`, `-linux-arm64`, `-linux-x64-musl`,
   `-linux-arm64-musl`, `-darwin-x64`, `-darwin-arm64`, `-win32-x64`,
   `-win32-arm64`), which `gitglasses-mcp` names as optional dependencies so
   npm installs the engine for its platform; then installs `gitglasses-mcp`
   with the linux-x64 engine package from a clean npm install and has it read
   a repository;
5. waits for the CI workflow to have passed on the tagged commit itself,
   from its push to `main` (a pull request run does not count: it tested
   the pull request merged into its base branch);
6. prepares the GitHub release's assets: `SHA256SUMS`, symbol archives,
   build provenance attestations for the VSIXes, and this version's
   changelog section as the notes;
7. once all of the above has succeeded, publishes to the Visual Studio
   Marketplace, Open VSX and npm (the engine packages first, then
   `gitglasses-mcp`), each from its own job in the `release` environment,
   which needs your approval;
8. creates the GitHub release once both extension registries have every
   package.

Every publish step skips versions that already exist, so re-running a failed
job finishes a partial release. A missing credential fails the job with an
error naming what to set; nothing is skipped silently.

Odd minor versions (0.3.x, 0.5.x) are pre-releases: packaged and published on
the pre-release channel, tagged `next` on npm and marked as pre-releases on
GitHub. Even minor versions are stable.

## One-time setup

Work through these in order. Steps 1 to 4 and the npm names in step 8 are
urgent: until they are done, anyone can create the `gitglasses` namespace on
Open VSX, or register `gitglasses-mcp` or the `@gitglasses` scope on npm, and
publish under our name.

### 1. Eclipse account

Open VSX is run by the Eclipse Foundation, and publishing needs an Eclipse
account linked to the GitHub account that owns the repository.

1. Register at <https://accounts.eclipse.org/user/register>.
2. In the Eclipse account's profile, set **GitHub Username** to `danielwoz`.

### 2. Open VSX publisher agreement

1. Sign in to <https://open-vsx.org> with GitHub (`danielwoz`).
2. Open your settings (avatar > Settings) and log in with the Eclipse account
   from step 1 to link it.
3. Read and sign the Eclipse Foundation Open VSX Publisher Agreement shown
   there. Publishing fails until it is signed.
4. Under **Access Tokens**, generate a token (description: `gitglasses
   release`). Copy it; it is shown once. It is used in steps 3 and 6.

### 3. Create the namespace

The namespace must exist before anything can be published to it. With the
token from step 2, using the ovsx version the release pins:

```sh
pnpm install --frozen-lockfile
cd scripts
OVSX_PAT=<token> pnpm exec ovsx create-namespace gitglasses
```

`npx --yes ovsx@1.2.0 create-namespace gitglasses -p <token>` does the same
without a checkout. Check it at <https://open-vsx.org/api/gitglasses>.

### 4. Claim namespace ownership

Creating a namespace does not make you its verified owner, and until it is
verified the listing shows a warning. Open a **Claim namespace ownership**
issue at <https://github.com/EclipseFdn/open-vsx.org/issues/new/choose> for
`gitglasses`, pointing at the Marketplace publisher
<https://marketplace.visualstudio.com/publishers/gitglasses> and this
repository as proof that the same person owns both. The owner role is also
what step 6's trusted publishing needs.

### 5. The `release` environment

In the repository's **Settings > Environments**, create `release`:

- **Required reviewers**: yourself. Every publish job then waits for your
  approval (approve the three pending deployments together).
- **Deployment branches and tags**: *Selected branches and tags*, with one
  rule: tag `v*`. Nothing but a release tag can reach the publishing
  credentials.

Or with the GitHub CLI:

```sh
gh api -X PUT repos/danielwoz/gitglasses/environments/release --input - <<EOF
{"reviewers":[{"type":"User","id":$(gh api user --jq .id)}],
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
EOF
gh api -X POST repos/danielwoz/gitglasses/environments/release/deployment-branch-policies \
  -f name='v*' -f type=tag
```

### 6. Secrets and variables

All of these belong to the `release` environment, not the repository, so
only approved release jobs can read them. Set them under **Settings >
Environments > release**, or with `gh secret set NAME --env release` and
`gh variable set NAME --env release --body VALUE`.

| Name | Kind | Used by | Set it |
| --- | --- | --- | --- |
| `VSCE_PAT` | secret | Marketplace | Now, with the current Azure DevOps PAT, until step 7 is done. Then delete the repository-level `VSCE_PAT` (`gh secret delete VSCE_PAT`). |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` | variables | Marketplace | In step 7. Once set, the Marketplace job signs in with Entra ID and ignores `VSCE_PAT`. |
| `OVSX_PAT` | secret | Open VSX | Now, with the token from step 2. The first Open VSX publish must use it. |
| `OVSX_TRUSTED_PUBLISHING` | variable | Open VSX | `true`, after the first publish, once trusted publishing is registered (below). Then delete `OVSX_PAT`. |
| `NPM_TRUSTED_PUBLISHING` | variable | npm | `true`, once step 8 is done. |
| `NPM_TOKEN` | secret | npm | For the first release that publishes the engine packages (step 8), and until trusted publishing is configured for every package. A granular token with read and write access to `gitglasses-mcp` and the `@gitglasses` scope. Delete it afterwards. |

**Open VSX trusted publishing.** After the first release has published with
`OVSX_PAT` and the ownership claim is granted, register a trusted publisher
for the `gitglasses.gitglasses` extension on open-vsx.org (see the Open VSX
wiki's Trusted Publishing page): GitHub Actions, repository
`danielwoz/gitglasses`, workflow `release.yml`, environment `release`. Set
`OVSX_TRUSTED_PUBLISHING` to `true`, and delete `OVSX_PAT` and the token.

### 7. Marketplace: Entra ID instead of a PAT (before 2026-12-01)

Global Azure DevOps personal access tokens, which is what the Marketplace
needs, stop working on 2026-12-01. Replace `VSCE_PAT` with a managed identity
that GitHub signs in as through OIDC; no secret is stored.

Do this once 0.2.0 has been released with `VSCE_PAT` (step 4 runs a helper
workflow from a release tag), and before 2026-12-01. Setting the two
variables in step 3 switches the next release to Entra ID, so finish steps
4 and 5 before tagging again. You need an Azure subscription (a free one is
enough) for the identity.

1. Create a user-assigned managed identity and note its client and tenant
   IDs:

   ```sh
   az group create --name gitglasses-release --location eastus
   az identity create --resource-group gitglasses-release --name gitglasses-marketplace
   az identity show --resource-group gitglasses-release --name gitglasses-marketplace \
     --query '{clientId: clientId, tenantId: tenantId}'
   ```

2. Let the `release` environment of this repository sign in as it:

   ```sh
   az identity federated-credential create \
     --resource-group gitglasses-release --identity-name gitglasses-marketplace \
     --name github-release \
     --issuer https://token.actions.githubusercontent.com \
     --subject repo:danielwoz/gitglasses:environment:release \
     --audiences api://AzureADTokenExchange
   ```

3. Set the `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` variables of the
   `release` environment to the two IDs.

4. Find the identity's Marketplace user ID. The lookup must run as the
   identity, so it runs in the **Marketplace identity** workflow
   (`.github/workflows/marketplace-identity.yml`). The `release`
   environment only admits `v*` tags, so start it on the latest release tag:

   ```sh
   gh workflow run marketplace-identity.yml --ref v0.2.0
   ```

   Approve the deployment; the ID is in the run's summary.

5. At <https://marketplace.visualstudio.com/manage/publishers/gitglasses>,
   open **Members**, add that ID and give it the **Contributor** role.

6. The next release publishes through Entra ID. When it has succeeded,
   delete `VSCE_PAT` from the environment and revoke the PAT in Azure DevOps.

To switch before 0.2.0 instead, run step 4 on `main`: temporarily add
`main` to the environment's deployment rules, run the workflow with
`--ref main`, and remove the rule again.

### 8. npm: `gitglasses-mcp` and the engine packages, with trusted publishing

A release publishes nine npm packages: `gitglasses-mcp` and the eight engine
packages it names as optional dependencies, `@gitglasses/engine-linux-x64`,
`@gitglasses/engine-linux-arm64`, `@gitglasses/engine-linux-x64-musl`,
`@gitglasses/engine-linux-arm64-musl`, `@gitglasses/engine-darwin-x64`,
`@gitglasses/engine-darwin-arm64`, `@gitglasses/engine-win32-x64` and
`@gitglasses/engine-win32-arm64` (the list is `ENGINE_PACKAGES` in
`scripts/lib/mcp-package.mjs`).

1. Reserve the names now. Create the `gitglasses` organisation at
   <https://www.npmjs.com/org/create> (this holds the `@gitglasses` scope,
   so nobody else can publish an engine package under it), and publish a
   placeholder `gitglasses-mcp@0.0.1` from your machine: a `package.json`
   with just the name, version, `"license": "MIT"` and the repository, plus a
   README saying the real package arrives with 0.4.1. Then `npm deprecate
   gitglasses-mcp@0.0.1 "placeholder; use 0.4.1 or newer"`.
2. npm configures trusted publishing per package, and a package must exist
   before it can be configured. For the first release with engine packages,
   set the `NPM_TOKEN` secret of the `release` environment (step 6) and
   leave `NPM_TRUSTED_PUBLISHING` unset; that release publishes all nine.
3. Then, on each package's **Settings** page on npmjs.com, add a trusted
   publisher: GitHub Actions, user `danielwoz`, repository `gitglasses`,
   workflow `release.yml`, environment `release`. Under publishing access,
   require two-factor authentication and disallow tokens.
4. Set the `NPM_TRUSTED_PUBLISHING` variable of the `release` environment to
   `true` and delete `NPM_TOKEN`. The workflow then publishes with OIDC and a
   provenance attestation for every package.
5. After the first release is on npm, change the registration examples in
   `mcp-server/README.md` and the MCP section of `README.md` to
   `npx -y gitglasses-mcp@<version>`, and drop the "not on npm yet"
   paragraphs (the `mcp-package` test in `scripts/test` forbids `npx` in
   those README examples until then, so update it in the same change).
   The npm page needs no change: it shows `mcp-server/npm-readme.md`,
   which already gives the `npx` form for the published version.

### 9. Protect `main` and the release tags

Add two rulesets under **Settings > Rules > Rulesets**:

- **main**: target the default branch; require a pull request before
  merging; require status checks to pass: `engine (ubuntu-22.04, debug)`,
  `engine (ubuntu-22.04, asan)`, `engine (ubuntu-22.04, tsan, clang,
  clang++)`, `engine (ubuntu-22.04, release)`, `engine-windows`,
  `engine-macos`, `engine-wasm`, `extension`, `extension-e2e`, and
  `extension-windows` once it is green; block force pushes and deletion.
- **release tags**: target tags matching `v*`; restrict updates and
  deletions, so a published tag can never be moved or removed.

## Cutting a release

1. On a branch, set the version in `extension/package.json`,
   `mcp-server/package.json` and the root `package.json` (the engine takes
   its version from the extension manifest), and give
   `extension/CHANGELOG.md` a `## [x.y.z] - YYYY-MM-DD` section. That
   section becomes the GitHub release notes, so it must not be empty.
   `node scripts/check-versions.mjs` must pass.
2. Merge to `main` and let CI pass.
3. Tag the merge commit and push the tag. CI must have run on that exact
   commit when it was pushed to `main`, so tag the last commit of the push,
   never a commit from inside the pull request. The release fails if no
   such run starts within 30 minutes.

   ```sh
   git tag v0.2.0 <commit on main>
   git push origin v0.2.0
   ```

4. Approve the three deployments to `release` when the builds are done.
5. If a job fails, fix the cause and re-run the failed jobs: published
   versions are skipped. Never move or delete a pushed tag; if the commit
   itself is wrong, bump the patch version and tag again.

## Dry runs

**In GitHub.** Run the workflow by hand on any branch: Actions > Release >
Run workflow, or `gh workflow run release.yml --ref <branch>`. It runs the
version checks (without a tag), every engine build and test, all nine
packages and their smoke tests, the npm packs and install test, and prepares
the release assets. It publishes nothing and needs no approval.

**Locally**, from a checkout with the engine built (`cmake --preset release
&& cmake --build --preset release`), the wasm engine built (`cmake --preset
wasm && cmake --build --preset wasm`) and `pnpm install && pnpm build` done:

```sh
node scripts/check-versions.mjs --tag v0.2.0
node scripts/release-notes.mjs 0.2.0

node scripts/package-vsix.mjs --target linux-x64 --engine build/release/engine/gitglasses-engine
node scripts/package-vsix.mjs --target web
node scripts/verify-vsix.mjs dist/gitglasses-linux-x64-0.2.0.vsix --target linux-x64 --run

# gitglasses-mcp, plus an engine package for each engine found under
# engines/engine-<target>/ (here only the local linux-x64 build)
mkdir -p engines/engine-linux-x64
cp build/release/engine/gitglasses-engine engines/engine-linux-x64/
node scripts/pack-mcp.mjs --out dist-npm --engines engines
node scripts/verify-mcp-package.mjs dist-npm/gitglasses-mcp-0.2.0.tgz --version 0.2.0 \
  --engine-package dist-npm/gitglasses-engine-linux-x64-0.2.0.tgz

# Alpine engine (x64 here; arm64 on an arm64 host)
docker run --rm -v "$PWD:/src" alpine:3.22 sh /src/scripts/build-alpine-engine.sh
```

`cd extension && ../scripts/node_modules/.bin/vsce ls` lists what a package
would contain, and `pnpm exec ovsx verify-pat gitglasses` in `scripts/`
(with `OVSX_PAT` set) checks an Open VSX token without publishing.
