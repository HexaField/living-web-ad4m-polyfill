import { AD4MClient } from './client.js';
import { PersonalGraph } from './graph.js';
import { GovernanceEngine } from './governance.js';
import type {
  PerspectiveHandle,
  SemanticTriple,
  SignedTriple,
  ValidationResult,
  CapabilityInfo,
  GraphConstraint,
  ZcapCapability,
} from './types.js';

export class SharedGraph extends PersonalGraph {
  readonly sharedUrl: string;
  private governance: GovernanceEngine;

  constructor(uuid: string, name: string | null, sharedUrl: string, client: AD4MClient) {
    super(uuid, name, client);
    this.sharedUrl = sharedUrl;
    this.governance = new GovernanceEngine(uuid, client);
  }

  // ── Override addTriple to evaluate governance ──

  async addTriple(triple: SemanticTriple): Promise<SignedTriple> {
    // §10.1: Sync MUST evaluate governance for every incoming triple
    const result = await this.governance.canAddTriple(triple);
    if (!result.allowed) {
      throw new DOMException(
        `Governance rejected: ${result.reason}`,
        'NotAllowedError',
      );
    }
    return super.addTriple(triple);
  }

  async addTriples(triples: SemanticTriple[]): Promise<SignedTriple[]> {
    // Evaluate governance for every triple before batch add
    for (const triple of triples) {
      const result = await this.governance.canAddTriple(triple);
      if (!result.allowed) {
        throw new DOMException(
          `Governance rejected triple: ${result.reason}`,
          'NotAllowedError',
        );
      }
    }
    return super.addTriples(triples);
  }

  // ── Peer operations ──

  async peers(): Promise<string[]> {
    const data = await this._client.query<{ neighbourhoodOnlineAgents: string[] }>(
      `query($uuid: String!) { neighbourhoodOnlineAgents(perspectiveUUID: $uuid) }`,
      { uuid: this.uuid },
    );
    return data.neighbourhoodOnlineAgents;
  }

  async onlinePeers(): Promise<Array<{ did: string; lastSeen: string }>> {
    const peers = await this.peers();
    return peers.map(did => ({ did, lastSeen: new Date().toISOString() }));
  }

  async sendSignal(did: string, payload: unknown): Promise<void> {
    await this._client.mutate(
      `mutation($uuid: String!, $did: String!, $payload: JSON!) {
        neighbourhoodSendSignal(perspectiveUUID: $uuid, remoteAgentDid: $did, payload: $payload)
      }`,
      { uuid: this.uuid, did, payload },
    );
  }

  async broadcast(payload: unknown): Promise<void> {
    await this._client.mutate(
      `mutation($uuid: String!, $payload: JSON!) {
        neighbourhoodSendBroadcast(perspectiveUUID: $uuid, payload: $payload)
      }`,
      { uuid: this.uuid, payload },
    );
  }

  async leave(opts?: { retainLocalCopy?: boolean }): Promise<void> {
    if (!opts?.retainLocalCopy) {
      await this._client.mutate(
        `mutation($uuid: String!) { perspectiveRemove(uuid: $uuid) }`,
        { uuid: this.uuid },
      );
    }
    // If retainLocalCopy=true, just disconnect (perspective stays)
  }

  // ── Governance API (§9) ──

  async canAddTriple_check(triple: SemanticTriple): Promise<ValidationResult> {
    return this.governance.canAddTriple(triple);
  }

  async constraintsFor(entity: string): Promise<GraphConstraint[]> {
    return this.governance.constraintsFor(entity);
  }

  async myCapabilities(): Promise<CapabilityInfo[]> {
    return this.governance.myCapabilities();
  }

  async grantCapability(did: string, capability: ZcapCapability): Promise<void> {
    return this.governance.grantCapability(did, capability);
  }

  async revokeCapability(capabilityId: string): Promise<void> {
    return this.governance.revokeCapability(capabilityId);
  }

  // ── Static constructors ──

  static async shareGraph(
    graph: PersonalGraph,
    client: AD4MClient,
    linkLanguage: string,
    meta?: Record<string, string>,
  ): Promise<SharedGraph> {
    const metaInput = meta
      ? Object.entries(meta).map(([k, v]) => ({
          data: { source: 'self', predicate: k, target: v },
          author: '', timestamp: '', proof: { key: '', signature: '', valid: true },
        }))
      : [];
    const data = await client.mutate<{ neighbourhoodPublishFromPerspective: string }>(
      `mutation($uuid: String!, $ll: String!, $meta: PerspectiveInput!) {
        neighbourhoodPublishFromPerspective(perspectiveUUID: $uuid, linkLanguage: $ll, meta: $meta)
      }`,
      { uuid: graph.uuid, ll: linkLanguage, meta: { links: metaInput } },
    );
    return new SharedGraph(graph.uuid, graph.name, data.neighbourhoodPublishFromPerspective, client);
  }

  static async join(url: string, client: AD4MClient): Promise<SharedGraph> {
    let data;
    try {
      data = await client.mutate<{ neighbourhoodJoinFromUrl: PerspectiveHandle }>(
        `mutation($url: String!) {
          neighbourhoodJoinFromUrl(url: $url) { uuid name sharedUrl }
        }`,
        { url },
      );
    } catch (err) {
      throw new DOMException(
        `Failed to join neighbourhood: ${err instanceof Error ? err.message : String(err)}`,
        'NotSupportedError',
      );
    }
    const p = data.neighbourhoodJoinFromUrl;
    return new SharedGraph(p.uuid, p.name, p.sharedUrl ?? url, client);
  }
}
