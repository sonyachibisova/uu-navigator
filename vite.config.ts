import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// База для GitHub Pages: сайт живёт в подпапке https://<user>.github.io/<repo>/.
// Для локальной разработки и preview разумное значение по умолчанию — "/".
// В workflow деплоя переменная VITE_BASE выставляется автоматически
// из имени репозитория (см. .github/workflows/deploy.yml).
const base = process.env['VITE_BASE'] ?? '/';

export default defineConfig({
  base,
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@building': fileURLToPath(new URL('./src/building', import.meta.url)),
      '@interaction': fileURLToPath(new URL('./src/interaction', import.meta.url)),
      '@routing': fileURLToPath(new URL('./src/routing', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@nav': fileURLToPath(new URL('./src/nav', import.meta.url)),
      '@data': fileURLToPath(new URL('./data', import.meta.url)),
    },
  },
  build: {
    // Явный лимит предупреждения близко к бюджету бандла из правил проекта.
    chunkSizeWarningLimit: 700,
  },
});
