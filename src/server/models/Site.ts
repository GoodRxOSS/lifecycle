/**
 * Copyright 2026 GoodRx, Inc.
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

import Model from './_Model';

export type SiteStatus = 'active' | 'deleted' | 'expired';

export default class Site extends Model {
  siteId!: string;
  name!: string;
  status!: SiteStatus;
  activeVersionId?: string | null;
  fileCount!: number;
  sizeBytes!: number | string;
  expiresAt?: string | null;
  createdBy?: string | null;
  updatedBy?: string | null;

  static tableName = 'sites';
  static timestamps = true;
  static deleteable = true;

  static get relationMappings() {
    const SiteVersion = require('./SiteVersion').default;
    return {
      versions: {
        relation: Model.HasManyRelation,
        modelClass: SiteVersion,
        join: {
          from: 'sites.siteId',
          to: 'site_versions.siteId',
        },
      },
    };
  }
}
