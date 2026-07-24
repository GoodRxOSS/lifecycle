/**
 * Copyright 2025 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { S3Client } from '@aws-sdk/client-s3';
import {
  OBJECT_STORE_TYPE,
  OBJECT_STORE_ENDPOINT,
  OBJECT_STORE_PORT,
  OBJECT_STORE_ACCESS_KEY,
  OBJECT_STORE_SECRET_KEY,
  OBJECT_STORE_USE_SSL,
  OBJECT_STORE_REGION,
} from 'shared/config';

let _client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!_client) {
    if (OBJECT_STORE_TYPE === 's3') {
      _client = new S3Client({ region: OBJECT_STORE_REGION });
    } else {
      const protocol = OBJECT_STORE_USE_SSL === 'true' ? 'https' : 'http';
      _client = new S3Client({
        endpoint: `${protocol}://${OBJECT_STORE_ENDPOINT}:${OBJECT_STORE_PORT}`,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: {
          accessKeyId: OBJECT_STORE_ACCESS_KEY,
          secretAccessKey: OBJECT_STORE_SECRET_KEY,
        },
      });
    }
  }
  return _client;
}
