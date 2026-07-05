import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://mcp.toolsnap.app',
  output: 'static',
  trailingSlash: 'never',
  integrations: [sitemap()],
});
