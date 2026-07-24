# JSON schema

This utility defines and documents Lifecycle's JSON schema.

---

## How to use

### Basics

If adding a new version of the schema, update `/scripts/generateschema.ts` to include the new version.

Run `pnpm generate:schemas` to generate and/or update schemas.

### Updating comments

Go to `/src/server/lib/jsonschema/schemas/<version>` and add or update the comment for the schema property.

#### Example

```json
"version": {
  "type": "string",
  "format": "schema003Version",
  "comment": "the version of the schema"
},
```
