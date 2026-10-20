# GitGlasses

An open-source, MIT-licensed git supercharger for VS Code — a compatible
alternative to the full GitLens Pro feature set, powered by a native C++
analysis engine.

## Why

- **Fast.** All git analysis (blame, log topology, graph layout, diff, search)
  runs in a native engine (`gitglasses-engine`) using libgit2 in-process, with
  the `git` CLI as the compatibility oracle where it matters (credentials,
  signing, interactive rebase).
- **Open.** Every feature is MIT licensed. Features that GitLens Pro backs
  with a proprietary cloud service are reimplemented against provider APIs
  directly (GitHub, GitLab, Bitbucket, Azure DevOps, Jira, Linear) with your
  tokens stored locally in VS Code SecretStorage. There is no server and we
  never see your tokens or code.
- **Offline-capable AI.** AI features are bring-your-own-key (Anthropic,
  OpenAI, Gemini, VS Code language models) or fully offline via Ollama.

## Install

From 0.2.0, every release is published to the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=gitglasses.gitglasses)
for VS Code, and to [Open VSX](https://open-vsx.org/extension/gitglasses/gitglasses)
for VSCodium, Cursor, Windsurf, Theia, code-server, Gitpod and other Open VSX
hosts. Search for GitGlasses in the Extensions view, or:

```sh
code --install-extension gitglasses.gitglasses
```

The editor picks the package for its platform: Windows (x64, arm64), macOS
(Intel, Apple silicon), Linux (x64, arm64; glibc 2.28 or newer) and Alpine
Linux (x64, arm64) packages carry the native engine, and the `web` package
runs a read-only WebAssembly engine on vscode.dev and github.dev. `git` 2.34
or newer on `PATH` is needed outside the browser.

Each [GitHub release](https://github.com/danielwoz/gitglasses/releases) also
carries every `.vsix` with a `SHA256SUMS` file and build provenance
attestations, for offline installs:

```sh
gh attestation verify gitglasses-linux-x64-0.2.0.vsix --repo danielwoz/gitglasses
code --install-extension gitglasses-linux-x64-0.2.0.vsix
```

What changed in each release is in [the changelog](extension/CHANGELOG.md).

## MCP server

`gitglasses-mcp` (in `mcp-server/`) is a stdio MCP server that gives AI agents
blame, history, the commit graph, status, diffs, patches and pull requests
through the same engine. It is not on npm yet: build it from a clone and
register `node mcp-server/dist/cli.js` with your client, as
[its README](mcp-server/README.md) describes.

## Layout

| Path | What |
|---|---|
| `engine/` | C++ analysis daemon, JSON-RPC over stdio |
| `packages/protocol/` | Wire protocol: TypeBox schemas → TS types + generated C++ |
| `extension/` | VS Code extension (thin TypeScript shim over the engine) |
| `mcp-server/` | MCP server exposing the engine + integrations to AI tools |
| `fixtures/` | Deterministic fixture-repo generators for tests |
| `docs/` | Specs, parity gaps, clean-room policy |

## Building

Prerequisites: CMake ≥ 3.25, a C++20 compiler, [vcpkg](https://github.com/microsoft/vcpkg)
(`VCPKG_ROOT` set), Node.js ≥ 20, pnpm.

```sh
# engine
cmake --preset debug && cmake --build --preset debug
ctest --preset debug

# typescript workspaces
pnpm install && pnpm build
```

## Contributing

Read `docs/clean-room-policy.md` before contributing. In short: we never read
or copy GitLens source (including its MIT-licensed portions) — features are
implemented from public documentation and observed behavior only.

## License

MIT. See [LICENSE](LICENSE). Third-party notices in `NOTICE`.

GitGlasses is not affiliated with, endorsed by, or sponsored by GitKraken or
Axosoft. "GitLens" and "GitKraken" are trademarks of their respective owners,
referenced here only to describe compatibility.
