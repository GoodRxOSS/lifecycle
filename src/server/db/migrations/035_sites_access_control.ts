import type { Knex } from 'knex';

export const config = { transaction: true };

/** Run only behind the Sites writer/gateway upgrade barrier. Legacy rows remain public and unassigned. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('LOCK TABLE sites IN ACCESS EXCLUSIVE MODE');
  await knex.schema.alterTable('sites', (table) => {
    table.string('visibility', 16).notNullable().defaultTo('public');
    table.string('ownerKind', 16).notNullable().defaultTo('unresolved');
    table.string('ownerIssuer', 2048).nullable();
    table.string('ownerSubject', 255).nullable();
    // No FK: deleting or rotating a key must not delete or transfer the original owner's Sites.
    table.integer('creatorTokenId').nullable();
    table.string('servingGeneration', 32).nullable();
    table.integer('accessRevision').notNullable().defaultTo(1);
    table.integer('contentRevision').notNullable().defaultTo(1);
    table.index(['ownerIssuer', 'ownerSubject'], 'sites_owner_identity_idx');
    table.index(['creatorTokenId'], 'sites_creator_token_idx');
    table.index(['visibility', 'deletedAt'], 'sites_visibility_idx');
  });
  await knex.raw(`ALTER TABLE sites ALTER COLUMN visibility SET DEFAULT 'private'`);
  await knex.raw(`ALTER TABLE sites ADD CONSTRAINT sites_access_consistency CHECK (
    visibility IN ('private', 'public') AND "accessRevision" > 0 AND "contentRevision" > 0 AND (
      ("ownerKind" = 'user' AND "ownerIssuer" IS NOT NULL AND length("ownerIssuer") > 0 AND "ownerSubject" IS NOT NULL AND length("ownerSubject") > 0 AND "creatorTokenId" IS NULL) OR
      ("ownerKind" = 'service_key' AND "ownerIssuer" IS NULL AND "ownerSubject" IS NULL AND "creatorTokenId" IS NOT NULL AND "creatorTokenId" > 0) OR
      ("ownerKind" = 'unresolved' AND "ownerIssuer" IS NULL AND "ownerSubject" IS NULL AND "creatorTokenId" IS NULL)
    ) AND (visibility = 'public' OR ("ownerKind" = 'user' AND "servingGeneration" IS NOT NULL AND length("servingGeneration") > 0))
  )`);
  await knex.raw(`CREATE FUNCTION sites_preserve_owner() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF ROW(OLD."ownerKind", OLD."ownerIssuer", OLD."ownerSubject", OLD."creatorTokenId") IS DISTINCT FROM
       ROW(NEW."ownerKind", NEW."ownerIssuer", NEW."ownerSubject", NEW."creatorTokenId") THEN
      RAISE EXCEPTION 'Site ownership is immutable; use the explicit audited operator recovery transaction';
    END IF;
    RETURN NEW;
  END $$`);
  await knex.raw(
    `CREATE TRIGGER sites_preserve_owner BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION sites_preserve_owner()`
  );
  await knex.schema.alterTable('api_tokens', (table) => table.string('ownerIssuer', 2048).nullable());
  // Existing personal keys remain unbound. Reissue rather than guess their historical realm.
}

/**
 * Operator-approved downgrade: the old gateway serves active, unexpired Sites publicly.
 * Site rows, versions, and stored files remain; owner/visibility metadata does not.
 * Stop all new core processes before running this migration so startup cannot reapply it.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw('LOCK TABLE sites IN ACCESS EXCLUSIVE MODE');
  await knex.raw('DROP TRIGGER sites_preserve_owner ON sites');
  await knex.raw('DROP FUNCTION sites_preserve_owner()');
  await knex.raw('ALTER TABLE sites DROP CONSTRAINT sites_access_consistency');
  await knex.raw('DROP INDEX sites_owner_identity_idx');
  await knex.raw('DROP INDEX sites_creator_token_idx');
  await knex.raw('DROP INDEX sites_visibility_idx');
  await knex.raw(`ALTER TABLE sites
    DROP COLUMN visibility,
    DROP COLUMN "ownerKind",
    DROP COLUMN "ownerIssuer",
    DROP COLUMN "ownerSubject",
    DROP COLUMN "creatorTokenId",
    DROP COLUMN "servingGeneration",
    DROP COLUMN "accessRevision",
    DROP COLUMN "contentRevision"`);
  await knex.raw('ALTER TABLE api_tokens DROP COLUMN "ownerIssuer"');
}
