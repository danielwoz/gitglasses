# Contributing to GitGlasses

Thanks for helping. Bug reports, fixes, features and documentation are all
welcome. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Clean-room policy.** Read [docs/clean-room-policy.md](docs/clean-room-policy.md).
  Never read or copy GitLens source, including its MIT-licensed parts; features
  are built from public documentation and observed behaviour only. Every pull
  request affirms this.
- **Security issues** go through a private report, not an issue. See
  [SECURITY.md](SECURITY.md).
- **Larger changes:** open an issue first, so the approach can be agreed before
  you spend time on it.

## Setting up

The [Building](README.md#building) section of the README covers both setups:
TypeScript only (`pnpm install && pnpm build && pnpm fetch-engine`, no C++
toolchain needed) and the full build including the C++ engine.

| Path | What lives there |
|---|---|
| `engine/` | C++20 engine: JSON-RPC over stdio, libgit2 plus the git CLI |
| `packages/protocol/` | Wire protocol, schema first: TypeBox schemas, TS types and `protocol.schema.json` |
| `packages/rpc/` | The engine client shared by the extension and the MCP server |
| `packages/integrations/` | GitHub, GitLab, Bitbucket, Azure DevOps, Jira and Linear clients |
| `extension/` | The VS Code extension; webview sources are in `extension/webviews-src/` |
| `mcp-server/` | The `gitglasses-mcp` stdio MCP server; built and tested with everything else, but not shipped right now (neither in the extension nor on npm) |
| `scripts/` | Repository tooling (format check, engine download, packaging) |

## Making a change

- Keep a pull request to one logical change, split into small commits.
- Commit subjects follow `<type>: <imperative, lowercase summary>`, where the
  type is one of `fix`, `feat`, `test`, `ci`, `docs`, `release`, `refactor`,
  `perf`, `chore` or `style`. The body says what changed for users and why.
- Every behaviour fix comes with a regression test that fails without it:
  gtest for the engine, vitest for TypeScript. Tests use real git
  repositories rather than mocks wherever they can.
- Protocol changes start in `packages/protocol`. Run
  `pnpm --filter @gitglasses/protocol build` and commit the regenerated
  `protocol.schema.json`; CI fails when it is stale, and the engine's contract
  test checks live responses against it.
- Code comments say what the code does and why, not how it was arrived at.

## Checks

CI runs all of these on every pull request; running them first saves a round
trip.

| Check | Command |
|---|---|
| Lint (after `pnpm build`, for the type-aware rules) | `pnpm lint` |
| Formatting of what you changed | `pnpm format:check`, fixed by `pnpm format` |
| TypeScript tests | `pnpm test` |
| Extension type check | `cd extension && npx tsc -p tsconfig.json` |
| Engine tests | `ctest --preset debug -j 8` (or your host's preset) |
| VS Code end-to-end tests | `cd extension && pnpm test:e2e` |
| Web extension smoke test (needs the `wasm` preset build) | `pnpm --filter gitglasses run test:web` |
| Repository script tests | `pnpm test:scripts` |

### Formatting

The formatting check looks only at what your branch changes, measured from its
merge base with `main`:

- TypeScript and JavaScript files follow Prettier (`.prettierrc.json`). A file
  you change must be formatted if it is new or was formatted before; older
  files that were never formatted stay exempt until someone formats them.
- C++ follows `.clang-format`, checked on the lines you change with
  `git clang-format`. Install the exact version CI uses, because clang-format
  output changes between releases:
  `pipx install clang-format==23.1.3` (or `pip install --user clang-format==23.1.3`).

`pnpm format` rewrites exactly what the check reports. A change that only
reformats code belongs in a separate `style:` commit.

### Engine tests

ctest runs every test in its own process, so tests may run in parallel and
must not share state: create temporary directories with
`gg::testing::makeTempDir()` and fixture repositories with
`gg::testing::FixtureRepo` from `engine/tests/unit/test_fixtures.h`. The test
binary gives git a global configuration of its own, so tests behave the same
whatever your `~/.gitconfig` contains.

## Pull requests

Fill in the pull request template, including the clean-room affirmation.
Contributions are accepted under the project's [MIT license](LICENSE).
