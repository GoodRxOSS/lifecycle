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
import Site from './Site';

export type SiteVersionManifestEntry = {
  path: string;
  sizeBytes: number;
  contentType: string;
};

export default class SiteVersion extends Model {
  siteId!: string;
  versionId!: string;
  storagePrefix!: string;
  entrypoint!: string;
  fileCount!: number;
  sizeBytes!: number | string;
  manifest!: SiteVersionManifestEntry[];

  static tableName = 'site_versions';
  static timestamps = true;

  static get relationMappings() {
    return {
      site: {
        relation: Model.BelongsToOneRelation,
        modelClass: Site,
        join: {
          from: 'site_versions.siteId',
          to: 'sites.siteId',
        },
      },
    };
  }

  static get jsonAttributes() {
    return ['manifest'];
  }
}
