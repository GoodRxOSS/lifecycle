import { z } from 'zod';

const JSON_SCHEMA_KEYWORDS = new Set([
  '$defs',
  '$id',
  '$ref',
  '$schema',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'default',
  'description',
  'enum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'oneOf',
  'pattern',
  'properties',
  'required',
  'title',
  'type',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isZodSchemaLike(value) {
  return (
    isRecord(value) &&
    typeof value.parse === 'function' &&
    typeof value.safeParse === 'function'
  );
}

function isZodRawShapeLike(value) {
  if (!isRecord(value)) {
    return false;
  }

  const values = Object.values(value);
  return values.length === 0 || values.every((entry) => isZodSchemaLike(entry));
}

function isLikelyJsonSchema(value) {
  if (!isRecord(value)) {
    return false;
  }

  return Object.keys(value).some((key) => JSON_SCHEMA_KEYWORDS.has(key));
}

function applySchemaMetadata(schema, jsonSchema, { nullable = false } = {}) {
  let nextSchema = schema;

  if (nullable) {
    nextSchema = nextSchema.nullable();
  }

  if (typeof jsonSchema.description === 'string' && jsonSchema.description.trim()) {
    nextSchema = nextSchema.describe(jsonSchema.description.trim());
  }

  return nextSchema;
}

function buildLiteralUnion(values) {
  if (values.length === 0) {
    return z.never();
  }

  const literals = values.map((value) => z.literal(value));
  return literals.slice(1).reduce((schema, candidate) => schema.or(candidate), literals[0]);
}

function buildUnionSchema(schemas) {
  if (schemas.length === 0) {
    return z.any();
  }

  return schemas.slice(1).reduce((schema, candidate) => schema.or(candidate), schemas[0]);
}

function inferSchemaType(schema) {
  if (typeof schema.const !== 'undefined' || Array.isArray(schema.enum)) {
    return null;
  }

  if (Array.isArray(schema.type)) {
    const explicitTypes = schema.type.filter((value) => typeof value === 'string' && value !== 'null');
    if (explicitTypes.length > 0) {
      return explicitTypes[0];
    }
  }

  if (typeof schema.type === 'string' && schema.type !== 'null') {
    return schema.type;
  }

  if (isRecord(schema.properties) || typeof schema.additionalProperties !== 'undefined') {
    return 'object';
  }

  if (typeof schema.items !== 'undefined') {
    return 'array';
  }

  return null;
}

function mergeAllOfObjectSchemas(schemas) {
  const merged = {
    type: 'object',
    properties: {},
    required: [],
  };
  let sawObjectSchema = false;

  for (const candidate of schemas) {
    if (!isRecord(candidate) || inferSchemaType(candidate) !== 'object') {
      return null;
    }

    sawObjectSchema = true;

    if (isRecord(candidate.properties)) {
      Object.assign(merged.properties, candidate.properties);
    }

    if (Array.isArray(candidate.required)) {
      merged.required.push(...candidate.required.filter((value) => typeof value === 'string'));
    }

    if (candidate.additionalProperties === false) {
      merged.additionalProperties = false;
    } else if (
      typeof merged.additionalProperties === 'undefined' &&
      isRecord(candidate.additionalProperties)
    ) {
      merged.additionalProperties = candidate.additionalProperties;
    }
  }

  if (!sawObjectSchema) {
    return null;
  }

  merged.required = [...new Set(merged.required)];
  return merged;
}

function jsonSchemaToZod(schema) {
  if (!isRecord(schema)) {
    return z.any();
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const mergedObjectSchema = mergeAllOfObjectSchemas(schema.allOf);
    if (mergedObjectSchema) {
      return jsonSchemaToZod({
        ...schema,
        ...mergedObjectSchema,
        allOf: undefined,
      });
    }
  }

  const unionMembers = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;

  if (unionMembers) {
    const filteredMembers = unionMembers.filter((candidate) => isRecord(candidate));
    const nullable = filteredMembers.some(
      (candidate) =>
        candidate.type === 'null' ||
        candidate.const === null ||
        (Array.isArray(candidate.type) && candidate.type.includes('null'))
    );
    const nonNullMembers = filteredMembers.filter(
      (candidate) =>
        candidate.type !== 'null' &&
        candidate.const !== null &&
        !(Array.isArray(candidate.type) && candidate.type.length === 1 && candidate.type[0] === 'null')
    );

    return applySchemaMetadata(buildUnionSchema(nonNullMembers.map((candidate) => jsonSchemaToZod(candidate))), schema, {
      nullable,
    });
  }

  if (typeof schema.const !== 'undefined') {
    return applySchemaMetadata(z.literal(schema.const), schema);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const uniqueValues = [...new Set(schema.enum)];
    if (uniqueValues.every((value) => typeof value === 'string')) {
      if (uniqueValues.length === 1) {
        return applySchemaMetadata(z.literal(uniqueValues[0]), schema);
      }

      return applySchemaMetadata(z.enum(uniqueValues), schema);
    }

    return applySchemaMetadata(buildLiteralUnion(uniqueValues), schema);
  }

  const explicitTypes = Array.isArray(schema.type)
    ? schema.type.filter((value) => typeof value === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];
  const nullable = explicitTypes.includes('null');
  const schemaType = inferSchemaType(schema);

  switch (schemaType) {
    case 'object': {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const requiredKeys = new Set(
        Array.isArray(schema.required) ? schema.required.filter((value) => typeof value === 'string') : []
      );

      const shape = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => {
          const propertySchema = jsonSchemaToZod(value);
          return [key, requiredKeys.has(key) ? propertySchema : propertySchema.optional()];
        })
      );

      let objectSchema = z.object(shape);
      if (schema.additionalProperties === false) {
        objectSchema = objectSchema.strict();
      } else if (isRecord(schema.additionalProperties)) {
        objectSchema = objectSchema.catchall(jsonSchemaToZod(schema.additionalProperties));
      } else {
        objectSchema = objectSchema.passthrough();
      }

      return applySchemaMetadata(objectSchema, schema, { nullable });
    }
    case 'array': {
      const itemSchema = Array.isArray(schema.items)
        ? buildUnionSchema(schema.items.map((candidate) => jsonSchemaToZod(candidate)))
        : jsonSchemaToZod(schema.items);
      return applySchemaMetadata(z.array(itemSchema), schema, { nullable });
    }
    case 'string':
      return applySchemaMetadata(z.string(), schema, { nullable });
    case 'integer':
      return applySchemaMetadata(z.number().int(), schema, { nullable });
    case 'number':
      return applySchemaMetadata(z.number(), schema, { nullable });
    case 'boolean':
      return applySchemaMetadata(z.boolean(), schema, { nullable });
    case 'null':
      return z.null();
    default:
      return applySchemaMetadata(z.any(), schema, { nullable });
  }
}

function isZodObjectSchema(schema) {
  if (!isZodSchemaLike(schema)) {
    return false;
  }

  const v4Type = schema?._zod?.def?.type;
  if (v4Type === 'object') {
    return true;
  }

  return typeof schema.shape === 'object' || schema?._def?.typeName === 'ZodObject';
}

export function normalizeToolInputSchema(inputSchema) {
  if (!isRecord(inputSchema)) {
    return {};
  }

  if (isZodSchemaLike(inputSchema) || isZodRawShapeLike(inputSchema)) {
    return inputSchema;
  }

  if (!isLikelyJsonSchema(inputSchema)) {
    return {};
  }

  const normalizedSchema = jsonSchemaToZod(inputSchema);
  return isZodObjectSchema(normalizedSchema) ? normalizedSchema : z.object({}).passthrough();
}
