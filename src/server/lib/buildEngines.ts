export const NATIVE_BUILDER_ENGINES = ['buildkit', 'kaniko'] as const;
export const BUILDER_ENGINES = [...NATIVE_BUILDER_ENGINES, 'ci'] as const;

export type NativeBuilderEngine = (typeof NATIVE_BUILDER_ENGINES)[number];
export type BuilderEngine = (typeof BUILDER_ENGINES)[number];

export function isNativeBuilderEngine(engine: unknown): engine is NativeBuilderEngine {
  return NATIVE_BUILDER_ENGINES.includes(engine as NativeBuilderEngine);
}
