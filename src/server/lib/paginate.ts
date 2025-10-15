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
  const isPaginated = searchParams.has('page') || searchParams.has('limit');

  let results: T[];
  let totalItems: number;
  let metadata: PaginationMetadata;

  if (isPaginated) {
    const pageResult: Page<T> = await query.page(page - 1, limit);
    results = pageResult.results;
    totalItems = pageResult.total;
    metadata = {
      current: page,
      total: Math.ceil(totalItems / limit),
      items: totalItems,
      limit,
    };
  } else {
    results = await query;
  }

  return { data: results, metadata };
}
