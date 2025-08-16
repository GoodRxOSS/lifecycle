import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('api_keys', (table) => {
    table.increments('id').primary();
    table.string('key_id', 8).notNullable().unique();
    table.string('secret_hash', 255).notNullable();
    table.string('name', 255).notNullable();
    table.text('description');
    table.boolean('active').defaultTo(true);
    table.jsonb('scopes').defaultTo('[]');
    table.bigint('github_user_id');
    table.string('github_login', 255);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('expires_at');
    table.timestamp('last_used_at');

    // Indexes for performance
    table.index('key_id', 'idx_api_keys_key_id');
    table.index('active', 'idx_api_keys_active');
    table.index('expires_at', 'idx_api_keys_expires_at');
    table.index('last_used_at', 'idx_api_keys_last_used_at');
    table.index('github_user_id', 'idx_api_keys_github_user_id');
    table.index('github_login', 'idx_api_keys_github_login');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('api_keys');
}
