import { AD4MClient } from './client.js';
import { PersonalGraph } from './graph.js';
import { linkExpressionToSignedTriple } from './converters.js';
import type { PerspectiveHandle, LinkExpression, SignedTriple } from './types.js';

export class SharedGraph extends PersonalGraph {
  readonly sharedUrl: string;
  private _client: AD4MClient;

  constructor(uuid: string, name: string | null, sharedUrl: string, client: AD4MClient) {
    super(uuid, name, client);
    this.sharedUrl = sharedUrl;
    this._client = client;
  }

  async peers(): Promise<string[]> {
    const data = await this._client.query<{ neighbourhoodOnlineAgents: string[] }>(
      `query($uuid: String!) { neighbourhoodOnlineAgents(perspectiveUUID: $uuid) }`,
      { uuid: this.uuid },
    );
    return data.neighbourhoodOnlineAgents;
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
  }

  /** Share an existing PersonalGraph as a neighbourhood */
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

  /** Join a neighbourhood by URL */
  static async join(url: string, client: AD4MClient): Promise<SharedGraph> {
    const data = await client.mutate<{ neighbourhoodJoinFromUrl: PerspectiveHandle }>(
      `mutation($url: String!) {
        neighbourhoodJoinFromUrl(url: $url) { uuid name sharedUrl }
      }`,
      { url },
    );
    const p = data.neighbourhoodJoinFromUrl;
    return new SharedGraph(p.uuid, p.name, p.sharedUrl ?? url, client);
  }
}
