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
    await this.client.mutate(
      `mutation($uuid: String!, $name: String!, $sdnaCode: String!) {
        perspectiveAddSdna(uuid: $uuid, name: $name, sdnaCode: $sdnaCode, sdnaType: "subject_class")
      }`,
      { uuid: this.perspectiveUuid, name, sdnaCode: shapeJson },
    );
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
}
