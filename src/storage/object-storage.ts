export interface StoredObject {
  body: Buffer;
  contentType: string;
  sizeBytes: number;
}

export interface StoredObjectSummary {
  key: string;
  lastModified?: Date;
}

export interface ObjectStorage {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<StoredObject | null>;
  copyObject(sourceKey: string, destinationKey: string, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  listObjects(prefix: string): Promise<StoredObjectSummary[]>;
}

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, StoredObject & { lastModified: Date }>();

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, {
      body: Buffer.from(body),
      contentType,
      sizeBytes: body.byteLength,
      lastModified: new Date(),
    });
  }

  async getObject(key: string): Promise<StoredObject | null> {
    const stored = this.objects.get(key);
    return stored
      ? { body: Buffer.from(stored.body), contentType: stored.contentType, sizeBytes: stored.sizeBytes }
      : null;
  }

  async copyObject(sourceKey: string, destinationKey: string, contentType: string): Promise<void> {
    const source = this.objects.get(sourceKey);
    if (!source) throw new Error("Source storage object does not exist");
    await this.putObject(destinationKey, source.body, contentType);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async listObjects(prefix: string): Promise<StoredObjectSummary[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, lastModified: value.lastModified }));
  }
}
