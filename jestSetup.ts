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

process.env.PINO_LOGGER = 'false';
process.env.IS_TESTING = 'true';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://root:root@localhost:5432/lifecycle';
process.env.APP_DB_HOST = process.env.APP_DB_HOST || 'localhost';
process.env.APP_DB_PORT = process.env.APP_DB_PORT || '5432';
process.env.APP_DB_USER = process.env.APP_DB_USER || 'root';
process.env.APP_DB_PASSWORD = process.env.APP_DB_PASSWORD || 'root';
process.env.APP_DB_NAME = process.env.APP_DB_NAME || 'lifecycle';
process.env.APP_REDIS_HOST = process.env.APP_REDIS_HOST || 'localhost';
process.env.APP_REDIS_PORT = process.env.APP_REDIS_PORT || '6379';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.LIFECYCLE_MODE = process.env.LIFECYCLE_MODE || 'all';
process.env.GITHUB_PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY || 'test-key';
process.env.GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || 'test-secret';
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID || '1000';
process.env.GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '100000';
process.env.GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || 'test-secret';
process.env.GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || '100000';
