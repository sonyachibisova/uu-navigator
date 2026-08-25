// Flat config ESLint + typescript-eslint.
// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `_to_delete/**` — отложенный чужой код: без него проверка тонет
    // в его ошибках и перестаёт быть проверкой продукта.
    ignores: ['dist/**', 'node_modules/**', 'legacy/**', 'public/**', '_to_delete/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Неиспользуемые параметры с префиксом _ — разрешены (колбэки three.js).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
