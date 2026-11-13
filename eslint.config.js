import { builtinModules } from 'node:module'
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import ts from 'typescript-eslint'

const privilegedImports = [
  ...new Set([
    'electron',
    'electron/main',
    'electron/renderer',
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ]),
]

export default defineConfig(
  globalIgnores([
    'node_modules/**',
    'out/**',
    'dist/**',
    'test-results/**',
    'playwright-report/**',
    '.artifacts/**',
    '.idea/**',
    'resources/runtimes/archives/**',
    'resources/runtimes/unpacked/**',
    'resources/skills/**',
  ]),
  js.configs.recommended,
  ts.configs.recommended,
  vue.configs['flat/recommended'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: { parserOptions: { parser: ts.parser } },
    rules: { '@typescript-eslint/consistent-type-imports': 'error' },
  },
  {
    files: [
      '*.{js,ts}',
      'scripts/**/*.ts',
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'tests/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/renderer/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: privilegedImports,
          patterns: [
            {
              group: ['**/main/**', '**/preload/**'],
              message: '界面通过 preload API 调用桌面能力。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: privilegedImports,
          patterns: [
            {
              group: ['@/**', '**/main/**', '**/preload/**', '**/renderer/**'],
              message: '共享契约不能依赖具体运行进程。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['@/**', '**/renderer/**', '**/preload/**'] }],
    },
  },
  {
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['@/**', '**/main/**', '**/renderer/**'] }],
    },
  },
  {
    files: ['src/renderer/components/ui/**/*.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },
  prettier,
)
