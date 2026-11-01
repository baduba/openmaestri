import js from '@eslint/js';
import security from 'eslint-plugin-security';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import globals from 'globals';

// `detect-non-literal-fs-filename` and `detect-object-injection` fire on every dynamic path or
// property access and cannot tell safe from unsafe, so they are off. The risks they stand for
// are handled in code instead: ids that reach file paths go through safeId() (src/store.js),
// and lookups keyed by external input use Object.hasOwn.
const noisy = { 'security/detect-non-literal-fs-filename': 'off', 'security/detect-object-injection': 'off' };

export default [
  { ignores: ['node_modules/**', 'dist/**'] },
  js.configs.recommended,
  security.configs.recommended,
  { files: ['src/**', 'bin/**', 'test/**'], languageOptions: { globals: globals.node, sourceType: 'module' } },
  {
    files: ['web/**'],
    plugins: { 'no-unsanitized': noUnsanitized },
    languageOptions: { globals: globals.browser, sourceType: 'module' },
    rules: { 'no-unsanitized/method': 'error', 'no-unsanitized/property': 'error' },
  },
  {
    rules: {
      ...noisy,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error',
    },
  },
];
