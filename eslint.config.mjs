import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import importPlugin from 'eslint-plugin-import'

// Rule selection adopts the type-aware checks from the maintainer's larger
// TypeScript projects (Project-A's `eslint-base.config.cjs`), pruned to what
// applies to a CLI: drop Vue/Nuxt/Nx/yml plugins, drop the `naming-convention`
// rule (project-specific). Keep `no-floating-promises` and friends — they
// catch real bugs in async/shell-out code.
export default [
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint,
      import: importPlugin
    },
    rules: {
      // Plain ESLint
      'no-console': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-useless-escape': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // typescript-eslint
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-exports': [
        'error',
        { fixMixedExportsWithInlineTypeSpecifier: true }
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/no-var-requires': 'error',

      // import hygiene — catches accidentally importing a devDep at runtime
      // (this would have caught the `@crosscopy/clipboard` situation earlier)
      'import/no-extraneous-dependencies': 'error'
    },
    settings: {
      'import/resolver': {
        node: true,
        typescript: { alwaysTryTypes: true, project: './tsconfig.json' }
      }
    }
  },
  {
    ignores: ['node_modules/', 'dist/', '.husky/', '.yarn/']
  }
]
