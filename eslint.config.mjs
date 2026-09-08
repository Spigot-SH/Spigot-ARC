import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config for Spigot backend and CLI.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'backend/data/**',
      '**/*.tsbuildinfo',
      'security-log/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      /**
       * Was `warn` while a long tail of `any` sat at API, DB and wallet boundaries. That tail
       * is gone: rows are typed at the query with better-sqlite3's
       * `prepare<BindParameters, Result>` generic, thrown values go through
       * `errorMessage`/`errorField`, and genuinely open payloads are `unknown` and narrowed
       * before use.
       *
       * `error` because a warning does not hold a count at zero — it drifts back. If an
       * upstream shape is truly unknowable, model it as `unknown` and narrow it; do not
       * reintroduce `any` and do not disable this rule.
       */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          // `const { secret, ...safe } = row` is how private fields are stripped before a
          // response. The omitted names are unused by design — that is the whole point.
          ignoreRestSiblings: true,
        },
      ],
      'no-console': 'off',
    },
  },

  // The backend, CLI and build scripts are Node programs: no DOM, and console output is their
  // logging.
  {
    files: ['backend/**/*.ts', 'cli/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        require: 'readonly',
      },
    },
  },

  // Must stay last: switches off every rule that would fight Prettier's formatting.
  prettier,
);
