import { AD4MClient } from './client.js';
import { PersonalGraph } from './graph.js';
import { GovernanceEngine } from './governance.js';
import { GraphDiff, DiffDAG } from './graph-diff.js';
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
  readonly moduleHash: string;
  private governance: GovernanceEngine;
  private _diffDAG: DiffDAG;
  private _lastRevision: string | null = null;

  constructor(uuid: string, name: string | null, sharedUrl: string, client: AD4MClient, moduleHash?: string) {
    super(uuid, name, client);
    this.sharedUrl = sharedUrl;
    this.moduleHash = moduleHash ?? '';
    this.governance = new GovernanceEngine(uuid, client);
    this._diffDAG = new DiffDAG();
  }

  // ── Override addTriple to evaluate governance + track diffs ──

  async addTriple(triple: SemanticTriple): Promise<SignedTriple> {
    // §10.1: Sync MUST evaluate governance for every incoming triple
    const result = await this.governance.canAddTriple(triple);
    if (!result.allowed) {
      throw new DOMException(
        `Governance rejected: ${result.reason}`,
        'NotAllowedError',
      );
    }
    const signed = await super.addTriple(triple);

    // §4.2/§6.2: Track as GraphDiff with causal dependencies
    const parentRevisions = this._lastRevision ? [this._lastRevision] : [];
    const diff = new GraphDiff([signed], [], parentRevisions);
    const applied = await this._diffDAG.tryApply(diff);
    if (applied) {
      this._lastRevision = await diff.computeRevision();
    }

    return signed;
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
    const signedTriples = await super.addTriples(triples);

    // Track batch as single GraphDiff
    const parentRevisions = this._lastRevision ? [this._lastRevision] : [];
    const diff = new GraphDiff(signedTriples, [], parentRevisions);
    const applied = await this._diffDAG.tryApply(diff);
    if (applied) {
      this._lastRevision = await diff.computeRevision();
    }

    return signedTriples;
  }

  /**
   * Apply an incoming diff from a remote peer.
   * §6.2: MUST NOT apply diff until dependencies satisfied.
   * §10.1: Sync MUST evaluate governance for every incoming triple.
   */
  async applyRemoteDiff(diff: GraphDiff): Promise<boolean> {
    // Verify governance for all additions
    for (const triple of diff.additions) {
      const result = await this.governance.canAddTriple(triple.data);
      if (!result.allowed) {
        // §10.1: Rejected triples MUST NOT be stored or forwarded
        return false;
      }
    }

    const applied = await this._diffDAG.tryApply(diff);
    if (applied) {
      this._lastRevision = await diff.computeRevision();
      // Also flush any pending diffs that are now unblocked
      await this._diffDAG.flushPending();
    }
    return applied;
  }

  get lastRevision(): string | null {
    return this._lastRevision;
  }

  /**
   * §6.2: Return the latest committed revision hash for this shared graph.
   */
  async currentRevision(): Promise<string | null> {
    return this._lastRevision;
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
    opts?: { module?: string; relays?: string[] },
  ): Promise<SharedGraph> {
    // Map module to link language hash if provided
    const ll = opts?.module ?? linkLanguage;
    const metaEntries = meta
      ? Object.entries(meta).map(([k, v]) => ({
          data: { source: 'self', predicate: k, target: v },
          author: '', timestamp: '', proof: { key: '', signature: '', valid: true },
        }))
      : [];
    // Map relays to bootstrap servers in meta
    if (opts?.relays) {
      for (const relay of opts.relays) {
        metaEntries.push({
          data: { source: 'self', predicate: 'bootstrap', target: relay },
          author: '', timestamp: '', proof: { key: '', signature: '', valid: true },
        });
      }
    }
    const data = await client.mutate<{ neighbourhoodPublishFromPerspective: string }>(
      `mutation($uuid: String!, $ll: String!, $meta: PerspectiveInput!) {
        neighbourhoodPublishFromPerspective(perspectiveUUID: $uuid, linkLanguage: $ll, meta: $meta)
      }`,
      { uuid: graph.uuid, ll, meta: { links: metaEntries } },
    );
    return new SharedGraph(graph.uuid, graph.name, data.neighbourhoodPublishFromPerspective, client, ll);
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
