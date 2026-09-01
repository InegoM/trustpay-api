import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ObjectStorage, StoredObject, StoredObjectSummary } from "./object-storage.js";

interface S3ObjectStorageOptions {
  bucket: string;
  endpoint?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  serverSideEncryption?: "AES256" | "aws:kms";
}

export default class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly serverSideEncryption: "AES256" | "aws:kms" | undefined;

  constructor(options: S3ObjectStorageOptions) {
    this.bucket = options.bucket;
    this.serverSideEncryption = options.serverSideEncryption;
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      ...(options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }
        : {}),
    });
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(this.serverSideEncryption ? { ServerSideEncryption: this.serverSideEncryption } : {}),
      }),
    );
  }

  async getObject(key: string): Promise<StoredObject | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return null;
      const body = Buffer.from(await response.Body.transformToByteArray());
      return {
        body,
        contentType: response.ContentType ?? "application/octet-stream",
        sizeBytes: response.ContentLength ?? body.byteLength,
      };
    } catch (error) {
      if (error && typeof error === "object" && "$metadata" in error) {
        const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
        if (metadata?.httpStatusCode === 404) return null;
      }
      throw error;
    }
  }

  async copyObject(sourceKey: string, destinationKey: string, contentType: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeURIComponent(sourceKey).replaceAll("%2F", "/")}`,
        Key: destinationKey,
        ContentType: contentType,
        MetadataDirective: "REPLACE",
        ...(this.serverSideEncryption ? { ServerSideEncryption: this.serverSideEncryption } : {}),
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async listObjects(prefix: string): Promise<StoredObjectSummary[]> {
    const objects: StoredObjectSummary[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const item of response.Contents ?? []) {
        if (item.Key) objects.push({ key: item.Key, ...(item.LastModified ? { lastModified: item.LastModified } : {}) });
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }
}
