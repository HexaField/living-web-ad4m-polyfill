import { AD4MClient } from './client.js';
import type { SemanticTriple, SignedTriple, TripleQuery, SparqlResult, LinkExpression, LinkInput } from './types.js';
import { linkExpressionToSignedTriple, tripleToLink, tripleQueryToLinkQuery } from './converters.js';

export class PersonalGraph extends EventTarget {
  readonly uuid: string;
  readonly name: string | null;
  private client: AD4MClient;

  constructor(uuid: string, name: string | null, client: AD4MClient) {
    super();
    this.uuid = uuid;
    this.name = name;
    this.client = client;
  }

  async addTriple(triple: SemanticTriple): Promise<SignedTriple> {
    const link = tripleToLink(triple);
    const data = await this.client.mutate<{ perspectiveAddLink: LinkExpression }>(
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
    const links = triples.map(tripleToLink);
    const data = await this.client.mutate<{ perspectiveAddLinks: LinkExpression[] }>(
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
    const data = await this.client.mutate<{ perspectiveRemoveLink: boolean }>(
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
    const data = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
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
    // AD4M uses Prolog primarily; attempt SPARQL via perspectiveQueryProlog
    // or a future SPARQL endpoint
    const data = await this.client.query<{ perspectiveQueryProlog: string }>(
      `query($uuid: String!, $query: String!) {
        perspectiveQueryProlog(uuid: $uuid, query: $query)
      }`,
      { uuid: this.uuid, query: sparql },
    );
    // Parse Prolog result into SparqlResult format
    try {
      const parsed = JSON.parse(data.perspectiveQueryProlog);
      return { type: 'bindings', bindings: Array.isArray(parsed) ? parsed : [] };
    } catch {
      return { type: 'bindings', bindings: [] };
    }
  }

  async snapshot(): Promise<SignedTriple[]> {
    const data = await this.client.query<{ perspectiveSnapshot: { links: LinkExpression[] } }>(
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
}
