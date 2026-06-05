import "server-only";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

let s3: S3Client | null = null;
function getS3(): S3Client | null {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.S3_BUCKET_NAME) {
    return null;
  }
  if (!s3) {
    s3 = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3;
}

/** Upload a buffer to S3; returns the key (or null if S3 isn't configured). */
export async function uploadToS3(params: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<string | null> {
  const client = getS3();
  if (!client) {
    console.log(`[s3] (skipped, not configured) → would upload ${params.key}`);
    return null;
  }
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    }),
  );
  return params.key;
}

/** Pre-signed GET url for an object (valid 1h). */
export async function getSignedDownloadUrl(key: string): Promise<string | null> {
  const client = getS3();
  if (!client) return null;
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key: key }),
    { expiresIn: 3600 },
  );
}
