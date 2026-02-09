import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/data/storage/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/trading.db',
  },
});
