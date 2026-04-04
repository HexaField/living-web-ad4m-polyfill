import { AD4MClient } from './client.js';
import { PersonalGraph } from './graph.js';
import type { PerspectiveHandle } from './types.js';

export class PersonalGraphManager {
  private client: AD4MClient;

  constructor(client: AD4MClient) {
    this.client = client;
  }

  async create(name?: string): Promise<PersonalGraph> {
    const data = await this.client.mutate<{ perspectiveAdd: PerspectiveHandle }>(
      `mutation($name: String!) {
        perspectiveAdd(name: $name) { uuid name }
      }`,
      { name: name ?? '' },
    );
    const p = data.perspectiveAdd;
    return new PersonalGraph(p.uuid, p.name, this.client);
  }

  async list(): Promise<PersonalGraph[]> {
    const data = await this.client.query<{ perspectives: PerspectiveHandle[] }>(
      `query { perspectives { uuid name sharedUrl } }`,
    );
    return data.perspectives
      .filter(p => !p.sharedUrl) // Only personal (non-shared) perspectives
      .map(p => new PersonalGraph(p.uuid, p.name, this.client));
  }

  async get(uuid: string): Promise<PersonalGraph | null> {
    try {
      const data = await this.client.query<{ perspective: PerspectiveHandle | null }>(
        `query($uuid: String!) { perspective(uuid: $uuid) { uuid name } }`,
        { uuid },
      );
      if (!data.perspective) return null;
      return new PersonalGraph(data.perspective.uuid, data.perspective.name, this.client);
    } catch {
      return null;
    }
  }

  async remove(uuid: string): Promise<boolean> {
    try {
      const data = await this.client.mutate<{ perspectiveRemove: boolean }>(
        `mutation($uuid: String!) { perspectiveRemove(uuid: $uuid) }`,
        { uuid },
      );
      return data.perspectiveRemove;
    } catch {
      return false;
    }
  }
}
