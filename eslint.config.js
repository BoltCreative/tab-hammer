import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default defineConfig(
  {
    ignores: [
      '**/dist/',
      '**/dist-e2e/',
      '**/dist-store/',
      '**/release/',
      '**/node_modules/',
      '**/test-results/',
      '**/playwright-report/',
      '.worktrees/',
      '.superpowers/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions, ...globals.node } },
  },
  {
    // React code lives only in the extension's src/. Elsewhere (e.g. Playwright fixtures) `use` is
    // not a React hook.
    files: ['packages/extension/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
);
