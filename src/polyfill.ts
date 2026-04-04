import { Config, type AD4MPolyfillConfig } from './config.js';
import { AD4MClient } from './client.js';
import { PersonalGraphManager } from './graph-manager.js';
import { IdentityManager } from './identity.js';
import { SharedGraph } from './shared-graph.js';

declare global {
  interface Navigator {
    graph?: PersonalGraphManager & {
      join(url: string): Promise<SharedGraph>;
    };
    // credentials already exists in DOM types; we extend it
  }
}

/**
 * Install the AD4M-backed Living Web polyfill onto `navigator`.
 * If the executor is unreachable, throws (caller can fall back to standalone polyfills).
 */
export async function install(config?: AD4MPolyfillConfig): Promise<void> {
  const cfg = new Config(config);
  const client = new AD4MClient(cfg);

  const reachable = await client.isReachable();
  if (!reachable) {
    throw new Error(
      `AD4M executor not reachable at ${cfg.executorUrl}. ` +
      `Ensure the executor is running or fall back to standalone polyfills.`,
    );
  }

  // Auto-unlock if passphrase provided
  if (cfg.passphrase) {
    try {
      await client.mutate(
        `mutation($p: String!) { agentUnlock(passphrase: $p) { isUnlocked } }`,
        { p: cfg.passphrase },
      );
    } catch {
      // Agent may already be unlocked or not yet generated
    }
  }

  const graphManager = new PersonalGraphManager(client);
  const identityManager = new IdentityManager(client);

  // Attach join method to graph manager
  const graphWithJoin = Object.assign(graphManager, {
    join: (url: string) => SharedGraph.join(url, client),
  });

  // Install on navigator
  Object.defineProperty(navigator, 'graph', {
    value: graphWithJoin,
    writable: false,
    configurable: true,
  });
}

export { AD4MClient } from './client.js';
export { Config, type AD4MPolyfillConfig } from './config.js';
