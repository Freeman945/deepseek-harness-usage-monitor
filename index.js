/**
 * DSH Usage Monitor — Host entry.
 *
 * The Host half owns all data collection and exposes one authenticated JSON API
 * to its own browser half. The Client half (`client.js`) registers the sidebar
 * entry and the dashboard panel.
 *
 * Data sources (all official Harness mechanisms, no private APIs):
 *  - `sessionPersistence` for durable token usage stored in Session logs;
 *  - `session/event` for live token usage while a Session is running;
 *  - `deepseekAccount.getBalance()` for the real signed-in wallet balance;
 *  - `webServer` + `connection` for the same-origin, authenticated dashboard API.
 */

import { API_PREFIX, UsageMonitor } from './lib/monitor.js';

/** Host services this plugin cannot work without. */
export const inject = ['webServer', 'connection', 'sessionPersistence'];

const VERSION = '0.1.0';

/**
 * Mount the usage monitor.
 * @param {any} ctx Cordis context
 * @param {Record<string, unknown>} [config] plugin row config
 */
export function apply(ctx, config = {}) {
  const monitor = new UsageMonitor(ctx, config);

  ctx.effect(() => {
    void monitor.start();
    return () => monitor.dispose();
  }, 'usage-monitor: engine lifecycle');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => monitor.handleHttp(req, res),
      }),
    'usage-monitor: authenticated dashboard API',
  );

  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_USAGE_MONITOR__',
      value: { api: API_PREFIX, schemaVersion: 1, version: VERSION },
    });
  });
}
