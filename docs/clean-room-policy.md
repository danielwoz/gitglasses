# Clean-room policy

GitGlasses reimplements the *behavior* of GitLens (including GitLens Pro
features) under the MIT license. To keep that legally sound:

1. **Never read GitLens source code.** Not `src/plus/**` (proprietary
   license), and as policy, not the MIT-licensed portions either. No copying,
   no porting, no "just checking how they did it", no decompiling bundles.
2. **Spec-then-implement.** Features are specified in `docs/specs/` from
   public documentation, marketing pages, help articles, and observed
   behavior of the running product. Implementers work from the spec.
3. **Derived code must be declared.** If code is ever knowingly derived from
   an MIT-licensed source (GitLens or otherwise), it keeps the original
   copyright notice in the file header and gets an entry in
   `THIRD-PARTY-NOTICES.md`. When in doubt, rewrite from the spec.
4. **No GitLens/GitKraken assets.** No icons, logos, prompt text, or docs
   prose. Trademarks appear only nominatively ("compatible alternative to
   GitLens Pro features"). All identifiers live under `gitglasses.*`.
5. **PR attestation.** Every pull request affirms: "I did not consult GitLens
   proprietary source for this change."

Dependency licensing: MIT/BSD/Apache-2.0 only; libgit2 is GPLv2 *with linking
exception* (permitted — documented in `NOTICE`). No GPL-without-exception
dependencies anywhere.
