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
