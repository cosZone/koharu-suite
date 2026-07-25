import node from '@astrojs/node';
import baseConfig from './astro.fixture.base.config.mjs';

export default {
  ...baseConfig,
  adapter: node({ mode: 'standalone' }),
};
