// ESLint configuration for every TypeScript and JavaScript workspace in the
// repository; run it from the root with `pnpm lint` after `pnpm build` (the
// type-aware rules read the workspace packages' generated declarations).
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Sources that belong to a tsconfig project and so can be linted with type
// information. Tests and build scripts sit outside those projects and get the
// syntax-only rules.
const typedSources = [
  'extension/src/**/*.ts',
  'extension/webviews-src/**/*.ts',
  'extension/test-e2e/**/*.ts',
  'packages/*/src/**/*.ts',
  'mcp-server/src/**/*.ts',
];

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-e2e/**',
      '**/out/**',
      'build/**',
      '**/.vscode-test/**',
      '**/.vscode-test-web/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // A leading underscore marks a parameter or binding that is unused on
      // purpose (interface conformance, rest-sibling omission).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: typedSources,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    // Promise handling is where the extension host and the engine client fail
    // silently, so these rules are the ones worth type information.
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-duplicate-type-constituents': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
    },
  },
);
