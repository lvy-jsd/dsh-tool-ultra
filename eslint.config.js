// Flat ESLint config for the Tool Ultra monorepo.
//
// TypeScript ESM, Node 24. We keep the rule set deliberately small: the goal is
// to catch real bugs (unused variables, unreachable code, accidental globals)
// without churning over style. typescript-eslint's "recommended" is the base;
// a few noisy rules are relaxed to match the codebase's existing conventions.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Never lint generated output, vendored code, or lockfiles.
    ignores: [
      '**/dist/**',
      '**/lib/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'tsconfig.projects.generated.json',
      'package-lock.json',
      '.swiftnest-built/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Node built-ins used across the packages.
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        crypto: 'readonly',
        structuredClone: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        performance: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        globalThis: 'readonly',
      },
    },
  },
  {
    rules: {
      // The codebase uses `any` in a few deliberate spots (host interop); keep
      // it a warning, not an error, so lint stays green.
      '@typescript-eslint/no-explicit-any': 'warn',
      // `no-unused-vars` is handled by the TS-aware variant; silence the base.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // A handful of packages intentionally use `require`/CJS interop.
      '@typescript-eslint/no-require-imports': 'off',
      // Console output is normal in CLI tools and the panel.
      'no-console': 'off',
      // We do not enforce a specific import order.
      'no-undef': 'off',
    },
  },
)