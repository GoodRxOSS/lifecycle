import { HelmConfigBuilder, BuildConfigBuilder, GlobalConfigBuilder } from '../ConfigBuilder';

describe('ConfigBuilder', () => {
  describe('HelmConfigBuilder', () => {
    it('builds helm configuration with chart info', () => {
      const config = new HelmConfigBuilder()
        .setChartInfo('./charts/myapp', 'myapp', '1.0.0')
        .setHelmVersion('3.12.0')
        .build();

      expect(config).toEqual({
        chartPath: './charts/myapp',
        chartName: 'myapp',
        chartVersion: '1.0.0',
        helmVersion: '3.12.0',
      });
    });

    it('adds values and value files', () => {
      const config = new HelmConfigBuilder()
        .addValue('image.tag', 'v1.0.0')
        .addValue('replicas', '3')
        .addValueFile('values-prod.yaml')
        .build();

      expect(config.values).toEqual([
        { key: 'image.tag', value: 'v1.0.0' },
        { key: 'replicas', value: '3' },
      ]);
      expect(config.valueFiles).toEqual(['values-prod.yaml']);
    });

    it('enables native helm with default args', () => {
      const config = new HelmConfigBuilder().enableNativeHelm('--atomic --wait').build();

      expect(config.nativeHelm).toEqual({
        enabled: true,
        defaultArgs: '--atomic --wait',
      });
    });

    it('merges with defaults correctly', () => {
      const defaults = {
        helmVersion: '3.10.0',
        values: [{ key: 'namespace', value: 'default' }],
        valueFiles: ['values-default.yaml'],
      };

      const config = new HelmConfigBuilder()
        .setHelmVersion('3.12.0')
        .addValue('image.tag', 'v2.0.0')
        .mergeWithDefaults(defaults)
        .build();

      expect(config.helmVersion).toBe('3.12.0'); // Override default
      expect(config.values).toContainEqual({ key: 'namespace', value: 'default' }); // Keep default
      expect(config.values).toContainEqual({ key: 'image.tag', value: 'v2.0.0' }); // Keep new value
    });
  });

  describe('BuildConfigBuilder', () => {
    it('builds build configuration', () => {
      const config = new BuildConfigBuilder()
        .setEngine('kaniko')
        .setServiceAccount('build-sa')
        .setJobTimeout(3600)
        .build();

      expect(config).toEqual({
        engine: 'kaniko',
        serviceAccount: 'build-sa',
        jobTimeout: 3600,
      });
    });

    it('sets resources', () => {
      const config = new BuildConfigBuilder()
        .setResources({ cpu: '500m', memory: '1Gi' }, { cpu: '2', memory: '4Gi' })
        .build();

      expect(config.resources).toEqual({
        requests: { cpu: '500m', memory: '1Gi' },
        limits: { cpu: '2', memory: '4Gi' },
      });
    });

    it('sets buildkit endpoint', () => {
      const config = new BuildConfigBuilder().setBuildkitEndpoint('tcp://buildkit-custom:1234').build();

      expect(config.buildkit).toEqual({
        endpoint: 'tcp://buildkit-custom:1234',
      });
    });
  });

  describe('GlobalConfigBuilder', () => {
    it('builds global configuration', () => {
      const helmDefaults = {
        helmVersion: '3.12.0',
        deploymentMethod: 'native' as const,
      };

      const buildDefaults = {
        engine: 'buildkit' as const,
        jobTimeout: 2100,
      };

      const config = new GlobalConfigBuilder()
        .setHelmDefaults(helmDefaults)
        .setBuildDefaults(buildDefaults)
        .setServiceAccount('lifecycle-sa', 'admin')
        .enableNativeHelm()
        .build();

      expect(config).toEqual({
        helmDefaults,
        buildDefaults,
        serviceAccount: { name: 'lifecycle-sa', role: 'admin' },
        nativeHelm: { enabled: true },
      });
    });
  });
});
