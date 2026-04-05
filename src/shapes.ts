import { AD4MClient } from './client.js';
import type { LinkExpression } from './types.js';

export class ShapeManager {
  private client: AD4MClient;
  private perspectiveUuid: string;

  constructor(uuid: string, client: AD4MClient) {
    this.perspectiveUuid = uuid;
    this.client = client;
  }

  async addShape(name: string, shapeJson: string): Promise<void> {
    // Store shape definition as SDNA in perspective
    await this.client.mutate(
      `mutation($uuid: String!, $name: String!, $sdnaCode: String!) {
        perspectiveAddSdna(uuid: $uuid, name: $name, sdnaCode: $sdnaCode, sdnaType: "subject_class")
      }`,
      { uuid: this.perspectiveUuid, name, sdnaCode: shapeJson },
    );
    // Also store as a shacl://has_shape triple (content-addressed)
    const shapeHash = await this.contentHash(shapeJson);
    await this.client.mutate(
      `mutation($uuid: String!, $link: LinkInput!) {
        perspectiveAddLink(uuid: $uuid, link: $link) { author }
      }`,
      {
        uuid: this.perspectiveUuid,
        link: { source: 'self', predicate: 'shacl://has_shape', target: `shacl://${shapeHash}/${name}` },
      },
    );
  }

  /** Content-address a shape definition using SHA-256 */
  private async contentHash(content: string): Promise<string> {
    if (typeof globalThis.crypto?.subtle !== 'undefined') {
      const buf = new TextEncoder().encode(content);
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback: simple hash for environments without SubtleCrypto
    let h = 0;
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) - h + content.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(16);
  }

  async createInstance(shapeName: string, address: string, initialValues?: Record<string, unknown>): Promise<string> {
    const data = await this.client.mutate<{ perspectiveCreateSubject: string }>(
      `mutation($uuid: String!, $class: String!, $addr: String!, $vals: JSON) {
        perspectiveCreateSubject(uuid: $uuid, subjectClass: $class, exprAddr: $addr, initialValues: $vals)
      }`,
      { uuid: this.perspectiveUuid, class: shapeName, addr: address, vals: initialValues ?? {} },
    );
    return data.perspectiveCreateSubject;
  }

  async getInstances(shapeName: string): Promise<string[]> {
    // Query for instances matching the shape class
    const data = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
      `query($uuid: String!, $query: LinkQuery!) {
        perspectiveQueryLinks(uuid: $uuid, query: $query) {
          data { source predicate target }
        }
      }`,
      {
        uuid: this.perspectiveUuid,
        query: { predicate: 'rdf://type', target: shapeName },
      },
    );
    return data.perspectiveQueryLinks.map(le => le.data.source);
  }

  async getInstanceData(shapeName: string, address: string): Promise<Record<string, unknown>> {
    const data = await this.client.mutate<{ perspectiveGetSubjectData: string }>(
      `mutation($uuid: String!, $class: String!, $addr: String!) {
        perspectiveGetSubjectData(uuid: $uuid, subjectClass: $class, exprAddr: $addr)
      }`,
      { uuid: this.perspectiveUuid, class: shapeName, addr: address },
    );
    try {
      return JSON.parse(data.perspectiveGetSubjectData);
    } catch {
      return {};
    }
  }

  async setProperty(
    shapeName: string,
    address: string,
    propertyName: string,
    value: unknown,
  ): Promise<void> {
    // Remove existing triple for this property, then add new one
    const existing = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
      `query($uuid: String!, $query: LinkQuery!) {
        perspectiveQueryLinks(uuid: $uuid, query: $query) {
          author timestamp
          data { source predicate target }
          proof { key signature valid }
        }
      }`,
      {
        uuid: this.perspectiveUuid,
        query: { source: address, predicate: propertyName },
      },
    );
    // Remove old values
    for (const le of existing.perspectiveQueryLinks) {
      await this.client.mutate(
        `mutation($uuid: String!, $link: LinkExpressionInput!) {
          perspectiveRemoveLink(uuid: $uuid, link: $link)
        }`,
        {
          uuid: this.perspectiveUuid,
          link: {
            source: le.data.source,
            predicate: le.data.predicate,
            target: le.data.target,
            author: le.author,
            timestamp: le.timestamp,
            proof: le.proof,
          },
        },
      );
    }
    // Add new value
    await this.client.mutate(
      `mutation($uuid: String!, $link: LinkInput!) {
        perspectiveAddLink(uuid: $uuid, link: $link) { author }
      }`,
      {
        uuid: this.perspectiveUuid,
        link: { source: address, predicate: propertyName, target: String(value) },
      },
    );
  }

  async addToCollection(
    _shapeName: string,
    address: string,
    collectionPredicate: string,
    value: string,
  ): Promise<void> {
    await this.client.mutate(
      `mutation($uuid: String!, $link: LinkInput!) {
        perspectiveAddLink(uuid: $uuid, link: $link) { author }
      }`,
      {
        uuid: this.perspectiveUuid,
        link: { source: address, predicate: collectionPredicate, target: value },
      },
    );
  }

  async removeFromCollection(
    _shapeName: string,
    address: string,
    collectionPredicate: string,
    value: string,
  ): Promise<void> {
    // Find and remove the specific link
    const existing = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
      `query($uuid: String!, $query: LinkQuery!) {
        perspectiveQueryLinks(uuid: $uuid, query: $query) {
          author timestamp
          data { source predicate target }
          proof { key signature valid }
        }
      }`,
      {
        uuid: this.perspectiveUuid,
        query: { source: address, predicate: collectionPredicate, target: value },
      },
    );
    for (const le of existing.perspectiveQueryLinks) {
      await this.client.mutate(
        `mutation($uuid: String!, $link: LinkExpressionInput!) {
          perspectiveRemoveLink(uuid: $uuid, link: $link)
        }`,
        {
          uuid: this.perspectiveUuid,
          link: {
            source: le.data.source,
            predicate: le.data.predicate,
            target: le.data.target,
            author: le.author,
            timestamp: le.timestamp,
            proof: le.proof,
          },
        },
      );
    }
  }
}
