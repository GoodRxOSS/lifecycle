const nextConfig = require('./next.config');

describe('next config', () => {
  it('allows multipart uploads larger than the default request body clone limit', () => {
    expect(nextConfig.experimental?.middlewareClientMaxBodySize).toBe(200 * 1000 * 1000);
    expect(nextConfig.experimental?.middlewareClientMaxBodySize).toBeGreaterThan(10 * 1024 * 1024);
  });
});
