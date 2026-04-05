import { AD4MClient } from './client.js';
import type {
  SemanticTriple,
  SignedTriple,
  TripleQuery,
  SparqlResult,
  LinkExpression,
  ShapeDefinition,
  ShapeProperty,
} from './types.js';
import { linkExpressionToSignedTriple, tripleToLink, tripleQueryToLinkQuery } from './converters.js';
import { ShapeManager } from './shapes.js';

export class PersonalGraph extends EventTarget {
  readonly uuid: string;
  readonly name: string | null;
  protected _client: AD4MClient;
  private _shapes: ShapeManager;
  private _shapeRegistry: Map<string, ShapeDefinition> = new Map();
  private _agentDid: string | null = null;

  constructor(uuid: string, name: string | null, client: AD4MClient) {
    super();
    this.uuid = uuid;
    this.name = name;
    this._client = client;
    this._shapes = new ShapeManager(uuid, client);
  }

  /** Ensure we have the agent DID cached for identity checks */
  private async ensureIdentity(): Promise<string> {
    if (this._agentDid) return this._agentDid;
    const data = await this._client.query<{ agent: { did: string | null; isUnlocked: boolean } }>(
      `query { agent { did isUnlocked } }`,
    );
    if (!data.agent.did || !data.agent.isUnlocked) {
      throw new DOMException('No active identity — agent not initialized or locked', 'InvalidStateError');
    }
    this._agentDid = data.agent.did;
    return this._agentDid;
  }

  /** Validate triple against registered shapes (if any require it) */
  private async validateAgainstShapes(triple: SemanticTriple): Promise<void> {
    for (const [, shape] of this._shapeRegistry) {
      for (const prop of shape.properties) {
        if (triple.predicate === prop.path) {
          // Validate datatype if specified
          if (prop.datatype) {
            this.validateDatatype(triple.target, prop.datatype, prop.name);
          }
        }
      }
    }
  }

  /** Validate a value against a SHACL datatype */
  private validateDatatype(value: string, datatype: string, propName: string): void {
    switch (datatype) {
      case 'xsd:integer':
      case 'http://www.w3.org/2001/XMLSchema#integer':
        if (!/^-?\d+$/.test(value)) {
          throw new TypeError(`Value "${value}" does not match datatype integer for property "${propName}"`);
        }
        break;
      case 'xsd:decimal':
      case 'http://www.w3.org/2001/XMLSchema#decimal':
        if (!/^-?\d+(\.\d+)?$/.test(value)) {
          throw new TypeError(`Value "${value}" does not match datatype decimal for property "${propName}"`);
        }
        break;
      case 'xsd:boolean':
      case 'http://www.w3.org/2001/XMLSchema#boolean':
        if (value !== 'true' && value !== 'false') {
          throw new TypeError(`Value "${value}" does not match datatype boolean for property "${propName}"`);
        }
        break;
      case 'xsd:dateTime':
      case 'http://www.w3.org/2001/XMLSchema#dateTime':
        if (isNaN(Date.parse(value))) {
          throw new TypeError(`Value "${value}" does not match datatype dateTime for property "${propName}"`);
        }
        break;
      case 'xsd:anyURI':
      case 'http://www.w3.org/2001/XMLSchema#anyURI':
        try { new URL(value); } catch {
          throw new TypeError(`Value "${value}" is not a valid URI for property "${propName}"`);
        }
        break;
      // xsd:string always valid
    }
  }

  async addTriple(triple: SemanticTriple): Promise<SignedTriple> {
    await this.ensureIdentity();
    await this.validateAgainstShapes(triple);

    const link = tripleToLink(triple);
    const data = await this._client.mutate<{ perspectiveAddLink: LinkExpression }>(
      `mutation($uuid: String!, $link: LinkInput!) {
        perspectiveAddLink(uuid: $uuid, link: $link) {
          author timestamp
          data { source predicate target }
          proof { key signature valid }
        }
      }`,
      { uuid: this.uuid, link },
    );
    const signed = linkExpressionToSignedTriple(data.perspectiveAddLink);
    this.dispatchEvent(new CustomEvent('tripleadded', { detail: signed }));
    return signed;
  }

  async addTriples(triples: SemanticTriple[]): Promise<SignedTriple[]> {
    await this.ensureIdentity();

    // Validate ALL before sending any — MUST reject entire batch if any fails
    for (const triple of triples) {
      await this.validateAgainstShapes(triple);
    }

    const links = triples.map(tripleToLink);
    const data = await this._client.mutate<{ perspectiveAddLinks: LinkExpression[] }>(
      `mutation($uuid: String!, $links: [LinkInput!]!) {
        perspectiveAddLinks(uuid: $uuid, links: $links) {
          author timestamp
          data { source predicate target }
          proof { key signature valid }
        }
      }`,
      { uuid: this.uuid, links },
    );
    return data.perspectiveAddLinks.map(linkExpressionToSignedTriple);
  }

  async removeTriple(signed: SignedTriple): Promise<boolean> {
    const link = {
      source: signed.data.source,
      predicate: signed.data.predicate ?? '',
      target: signed.data.target,
      author: signed.author,
      timestamp: signed.timestamp,
      proof: { key: signed.proof.key, signature: signed.proof.signature, valid: true },
    };
    const data = await this._client.mutate<{ perspectiveRemoveLink: boolean }>(
      `mutation($uuid: String!, $link: LinkExpressionInput!) {
        perspectiveRemoveLink(uuid: $uuid, link: $link)
      }`,
      { uuid: this.uuid, link },
    );
    if (data.perspectiveRemoveLink) {
      this.dispatchEvent(new CustomEvent('tripleremoved', { detail: signed }));
    }
    return data.perspectiveRemoveLink;
  }

  async queryTriples(query: TripleQuery): Promise<SignedTriple[]> {
    const linkQuery = tripleQueryToLinkQuery(query);
    const data = await this._client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
      `query($uuid: String!, $query: LinkQuery!) {
        perspectiveQueryLinks(uuid: $uuid, query: $query) {
          author timestamp
          data { source predicate target }
          proof { key signature valid }
        }
      }`,
      { uuid: this.uuid, query: linkQuery },
    );
    return data.perspectiveQueryLinks.map(linkExpressionToSignedTriple);
  }

  async querySparql(sparql: string): Promise<SparqlResult> {
    // AD4M has Prolog and SPARQL via Oxigraph
    const data = await this._client.query<{ perspectiveQueryProlog: string }>(
      `query($uuid: String!, $query: String!) {
        perspectiveQueryProlog(uuid: $uuid, query: $query)
      }`,
      { uuid: this.uuid, query: sparql },
    );
    try {
      const parsed = JSON.parse(data.perspectiveQueryProlog);
      return { type: 'bindings', bindings: Array.isArray(parsed) ? parsed : [] };
    } catch {
      return { type: 'bindings', bindings: [] };
    }
  }

  async snapshot(): Promise<SignedTriple[]> {
    const data = await this._client.query<{ perspectiveSnapshot: { links: LinkExpression[] } }>(
      `query($uuid: String!) {
        perspectiveSnapshot(uuid: $uuid) {
          links {
            author timestamp
            data { source predicate target }
            proof { key signature valid }
          }
        }
      }`,
      { uuid: this.uuid },
    );
    return data.perspectiveSnapshot.links.map(linkExpressionToSignedTriple);
  }

  // ── Shape methods (delegated to ShapeManager with validation) ──

  async addShape(name: string, shapeJson: string): Promise<void> {
    // MUST validate SHACL JSON structure
    let parsed: ShapeDefinition;
    try {
      parsed = JSON.parse(shapeJson);
    } catch {
      throw new SyntaxError(`Invalid shape JSON: ${shapeJson}`);
    }
    if (!parsed.targetClass || !parsed.properties || !parsed.constructor) {
      throw new SyntaxError('Shape MUST have targetClass, properties, and constructor');
    }
    for (const prop of parsed.properties) {
      if (!prop.path || !prop.name) {
        throw new SyntaxError('Each shape property MUST have path and name');
      }
    }
    // Check unique name
    if (this._shapeRegistry.has(name)) {
      throw new DOMException(`Shape with name "${name}" already exists`, 'ConstraintError');
    }

    await this._shapes.addShape(name, shapeJson);
    this._shapeRegistry.set(name, parsed);
  }

  async getShapes(): Promise<string[]> {
    return Array.from(this._shapeRegistry.keys());
  }

  async createShapeInstance(
    shapeName: string,
    address: string,
    params?: Record<string, unknown>,
  ): Promise<string> {
    const shape = this._shapeRegistry.get(shapeName);
    if (shape) {
      // MUST reject with ConstraintError if required param missing
      for (const action of shape.constructor) {
        if (action.required !== false && action.paramName) {
          if (!params || !(action.paramName in params)) {
            throw new DOMException(
              `Required parameter "${action.paramName}" missing for shape "${shapeName}"`,
              'ConstraintError',
            );
          }
        }
      }
    }
    return this._shapes.createInstance(shapeName, address, params);
  }

  async getShapeInstances(shapeName: string): Promise<string[]> {
    return this._shapes.getInstances(shapeName);
  }

  async getShapeInstanceData(
    shapeName: string,
    address: string,
  ): Promise<Record<string, unknown>> {
    return this._shapes.getInstanceData(shapeName, address);
  }

  async setShapeProperty(
    shapeName: string,
    address: string,
    propertyName: string,
    value: unknown,
  ): Promise<void> {
    const shape = this._shapeRegistry.get(shapeName);
    if (shape) {
      const prop = shape.properties.find(p => p.name === propertyName);
      if (prop) {
        if (prop.writable === false) {
          throw new TypeError(`Property "${propertyName}" is not writable on shape "${shapeName}"`);
        }
        if (prop.datatype && typeof value === 'string') {
          this.validateDatatype(value, prop.datatype, propertyName);
        }
      }
    }
    await this._shapes.setProperty(shapeName, address, propertyName, value);
  }

  async addToShapeCollection(
    shapeName: string,
    address: string,
    collectionName: string,
    value: string,
  ): Promise<void> {
    const shape = this._shapeRegistry.get(shapeName);
    if (shape) {
      const prop = shape.properties.find(p => p.name === collectionName);
      if (prop?.maxCount != null) {
        // Check current count
        const data = await this.getShapeInstanceData(shapeName, address);
        const current = Array.isArray(data[collectionName]) ? data[collectionName] as unknown[] : [];
        if (current.length >= prop.maxCount) {
          throw new DOMException(
            `Collection "${collectionName}" would exceed maxCount of ${prop.maxCount}`,
            'ConstraintError',
          );
        }
      }
    }
    await this._shapes.addToCollection(shapeName, address, collectionName, value);
  }

  async removeFromShapeCollection(
    shapeName: string,
    address: string,
    collectionName: string,
    value: string,
  ): Promise<void> {
    const shape = this._shapeRegistry.get(shapeName);
    if (shape) {
      const prop = shape.properties.find(p => p.name === collectionName);
      const data = await this.getShapeInstanceData(shapeName, address);
      const current = Array.isArray(data[collectionName]) ? data[collectionName] as string[] : [];

      if (!current.includes(value)) {
        throw new DOMException(
          `Value "${value}" not found in collection "${collectionName}"`,
          'NotFoundError',
        );
      }

      if (prop?.minCount != null && current.length <= prop.minCount) {
        throw new DOMException(
          `Removing from "${collectionName}" would violate minCount of ${prop.minCount}`,
          'ConstraintError',
        );
      }
    }
    await this._shapes.removeFromCollection(shapeName, address, collectionName, value);
  }
}
