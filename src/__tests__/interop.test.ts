import { describe, it, expect } from 'vitest';

/**
 * Integration tests — require a running AD4M executor at localhost:12000.
 * Run with: INTEGRATION=1 npm test
 */

const SKIP = !process.env.INTEGRATION;

describe.skipIf(SKIP)('AD4M executor interop', () => {
  it('placeholder: create graph → verify perspective exists', async () => {
    // Import dynamically to avoid issues when executor isn't running
    const { AD4MClient } = await import('../client.js');
    const { PersonalGraphManager } = await import('../graph-manager.js');
    const { Config } = await import('../config.js');

    const config = new Config();
    const client = new AD4MClient(config);
    const manager = new PersonalGraphManager(client);

    const graph = await manager.create('interop-test');
    expect(graph.uuid).toBeTruthy();

    const fetched = await manager.get(graph.uuid);
    expect(fetched).not.toBeNull();
    expect(fetched!.uuid).toBe(graph.uuid);

    await manager.remove(graph.uuid);
    const removed = await manager.get(graph.uuid);
    expect(removed).toBeNull();
  });
});
