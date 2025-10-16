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

import { Page, QueryBuilder } from 'objection';

/**
 * Interface for the pagination metadata.
 */
export interface PaginationMetadata {
  current: number;
  total: number;
  items: number;
  limit: number;
}

/**
 * Interface for the paginated response.
 */
interface PaginatedResponse<T> {
  data: T[];
  metadata: PaginationMetadata;
}

/**
 * A reusable pagination utility for Objection.js queries.
 *
 * @param query The Objection.js query builder instance.
 * @param searchParams The URLSearchParams from the NextRequest.
 * @returns A promise that resolves to an object containing results and metadata.
 */
import { Model } from 'objection';

export async function paginate<T extends Model>(
  query: QueryBuilder<any, any>,
  searchParams: URLSearchParams
): Promise<PaginatedResponse<T>> {
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = parseInt(searchParams.get('limit') || '25', 10);

  const pageResult: Page<T> = await query.page(page - 1, limit);
  const totalItems = pageResult.total;

  const metadata: PaginationMetadata = {
    current: page,
    total: Math.ceil(totalItems / limit),
    items: totalItems,
    limit,
  };

  return { data: pageResult.results, metadata };
}
