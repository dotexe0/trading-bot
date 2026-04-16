/**
 * Dashboard server configuration.
 *
 * Defines the Zod schema for dashboard server config with sensible
 * defaults. Port 3001 avoids conflicts with typical frontend dev servers.
 */

import { z } from 'zod';

export const dashboardConfigSchema = z.object({
  port: z.number().default(3001),
  host: z.string().default('127.0.0.1'),
  isDev: z.boolean().default(process.env.NODE_ENV !== 'production'),
});

export type DashboardConfig = z.infer<typeof dashboardConfigSchema>;
