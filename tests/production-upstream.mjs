import { once } from 'node:events';
import { createApp } from '../apps/mock/dist/app.js';

// Intercept requests to the fixed production origin without contacting it.
if (process.argv[1]?.endsWith('site-server.js')) {
  const fixture = createApp().listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const fetchHttp = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== 'https://admin-lm.zdhxylc.shop') throw new Error('Unexpected upstream');
    if (JSON.parse(options.body).redeem_code === 'UPSTREAM-OFFLINE') throw new Error('Fixture outage');
    return fetchHttp(`http://127.0.0.1:${fixture.address().port}${url.pathname}`, options);
  };
}
