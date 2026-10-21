export const NATIVE_BUILDER_ENGINES = ['buildkit', 'kaniko'] as const;
export const BUILDER_ENGINES = [...NATIVE_BUILDER_ENGINES, 'ci'] as const;

export const BUILD_CACHE_MODES = ['max', 'min', 'off'] as const;

export type NativeBuilderEngine = (typeof NATIVE_BUILDER_ENGINES)[number];
export type BuilderEngine = (typeof BUILDER_ENGINES)[number];
export type BuildCacheMode = (typeof BUILD_CACHE_MODES)[number];

export const DEFAULT_BUILD_CACHE_MODE: BuildCacheMode = 'max';

export function isNativeBuilderEngine(engine: unknown): engine is NativeBuilderEngine {
  return NATIVE_BUILDER_ENGINES.includes(engine as NativeBuilderEngine);
}

export function isBuildCacheMode(value: unknown): value is BuildCacheMode {
  return BUILD_CACHE_MODES.includes(value as BuildCacheMode);
}
