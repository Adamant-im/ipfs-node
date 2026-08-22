import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    // `.claude/` holds scratch worktrees with their own checked-out copies of
    // this repository; linting them would report the same file many times
    ignores: ['dist/', 'dist-test/', 'node_modules/', '.claude/', '.ai-ignored/', '.ai-tasks/']
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ['**/*.ts'],
    rules: {
      // Express error handlers must declare `next` to be recognised as such,
      // and route handlers frequently ignore `req`
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }
      ]
    }
  },
  prettier
)
