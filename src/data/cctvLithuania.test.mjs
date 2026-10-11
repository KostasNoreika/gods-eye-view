import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EISMOINFO_FEATURE_INFO_URL,
  EISMOINFO_USER_AGENT,
  EISMOINFO_VKR_URL,
  LITHUANIA_LIST_CACHE_MS,
  LITHUANIA_RESOLVE_CACHE_MS,
} from '../../server/providers/cctv/constants.js';
import {
  loadLithuaniaSourcesFromEismoinfo,
  parseEismoinfoVkrList,
} from '../../server/providers/cctv/sources.js';
import {
  cctvUpstreamUserAgent,
  eismoinfoPhotoUrl,
  eismoinfoUnavailableFrame,
  fetchEismoinfoSnapshot,
  resolveEismoinfoSnapshotUrl,
} from '../../server/providers/cctv/media.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PHOTO =
  'https://eismoinfo.lt/eismoinfo-backend-v2/image-provider/camera/old?id=86326302';

function feature(id, lat, lon, name) {
  return {
    id: String(id),
    name,
    points: [{ point: [lat, lon] }],
  };
}

function vkr(features, layer = 'VKR') {
  return [{ layer, name: 'Vaizdo kameros', features }];
}

test('VKR parser keeps Lithuania cameras and stores no JPEG', () => {
  const cameras = parseEismoinfoVkrList(
    vkr([
      feature('5', 54.9568, 25.682, 'Pabradė 102'),
      feature('5', 54.9568, 25.682, 'duplicate'),
      feature('72', 54.6426, 25.1798, 'Vilnius A1'),
      feature('out', 52.0, 25.0, 'south of the box'),
      feature('bad/id', 54.7, 25.3, 'slash'),
      { id: '9', name: 'no point' },
    ]).concat(vkr([feature('1', 54.7, 25.3, 'other layer')], 'WEATHER')),
  );
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['lt-vkr-5', 'lt-vkr-72'],
  );
  const pabrade = cameras[0];
  assert.equal(pabrade.provider, 'Via Lietuva / eismoinfo.lt');
  assert.equal(pabrade.lat, 54.9568);
  assert.equal(pabrade.lon, 25.682);
  assert.equal(pabrade.snapshotUrl, '');
  assert.equal(pabrade.url, EISMOINFO_FEATURE_INFO_URL('5'));
  assert.equal(pabrade.url.includes('image-provider'), false);
  assert.equal(pabrade.sourceKind, 'eismoinfo-vkr');
  assert.equal(pabrade.feedType, 'image');
});

test('photo URL accepts only the eismoinfo image host', () => {
  assert.equal(
    eismoinfoPhotoUrl({ info: [{ photos: [PHOTO] }] }),
    PHOTO,
  );
  assert.equal(eismoinfoPhotoUrl({ info: [{ photos: [] }] }), '');
  assert.equal(eismoinfoPhotoUrl({ info: [{ photos: [{}] }] }), '');
  assert.equal(
    eismoinfoPhotoUrl({
      info: [{ photos: ['http://eismoinfo.lt/eismoinfo-backend-v2/image-provider/x'] }],
    }),
    '',
  );
  assert.equal(
    eismoinfoPhotoUrl({
      info: [{ photos: ['https://evil.test/eismoinfo-backend-v2/image-provider/x'] }],
    }),
    '',
  );
  assert.equal(
    eismoinfoPhotoUrl({
      info: [{ photos: ['https://eismoinfo.lt.evil.test/eismoinfo-backend-v2/image-provider/x'] }],
    }),
    '',
  );
  assert.equal(
    eismoinfoPhotoUrl({
      info: [{ photos: ['https://eismoinfo.lt/elsewhere/camera.jpg'] }],
    }),
    '',
  );
});

test('list cache lasts an hour and a failed fetch does not stick', async () => {
  const requested = [];
  let mode = 'ok';
  const fetchImpl = async (url, init) => {
    requested.push({ url: String(url), ua: init?.headers?.['User-Agent'] });
    if (mode === 'down') return new Response('no', { status: 503 });
    return Response.json(
      vkr([
        feature('5', 54.9568, 25.682, 'Pabradė 102'),
        feature('72', 54.6426, 25.1798, 'Vilnius A1'),
      ]),
    );
  };
  const cache = { at: 0, cameras: null };
  const now = { t: 1_000_000 };
  const load = () =>
    loadLithuaniaSourcesFromEismoinfo({
      fetchImpl,
      now: () => now.t,
      cache,
    });
  const first = await load();
  assert.equal(first.length, 2);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, EISMOINFO_VKR_URL);
  assert.equal(requested[0].ua, EISMOINFO_USER_AGENT);
  assert.equal(requested[0].url.includes('feature-info'), false);
  now.t += LITHUANIA_LIST_CACHE_MS - 1;
  assert.equal((await load()).length, 2);
  assert.equal(requested.length, 1);
  const stamped = cache.at;
  mode = 'down';
  now.t += 2;
  assert.equal((await load()).length, 2);
  assert.equal(cache.at, stamped);
  mode = 'ok';
  now.t = stamped + LITHUANIA_LIST_CACHE_MS;
  assert.equal((await load()).length, 2);
  assert.equal(requested.length, 3);
  assert.ok(requested.every((row) => !String(row.url).includes('feature-info')));
});

test('empty photos is one cached miss and the viewer says no current image', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return Response.json({ name: 'Pabradė', info: [{ photos: [] }] });
  };
  const cache = new Map();
  const inflight = new Map();
  const opts = { fetchImpl, cache, inflight };
  assert.equal(
    await resolveEismoinfoSnapshotUrl('lt-vkr-5', { ...opts, now: 1_000 }),
    '',
  );
  assert.equal(
    await resolveEismoinfoSnapshotUrl('lt-vkr-5', {
      ...opts,
      now: 1_000 + 30_000,
    }),
    '',
  );
  assert.equal(calls.length, 1);
  assert.equal(await fetchEismoinfoSnapshot('lt-vkr-5', { ...opts, now: 1_000 }), null);
  const svg = eismoinfoUnavailableFrame({
    cameraId: 'lt-vkr-5',
    label: 'Pabradė 102',
    city: 'Lithuania',
  });
  assert.match(svg, /NO CURRENT IMAGE/);
  assert.match(svg, /Via Lietuva \/ eismoinfo\.lt/);
});

test('feature-info is fetched once per minute and the JPEG uses the browser UA', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), ua: init?.headers?.['User-Agent'] });
    if (String(url).includes('feature-info')) {
      return Response.json({ info: [{ photos: [PHOTO] }] });
    }
    return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  };
  const cache = new Map();
  const inflight = new Map();
  const opts = { fetchImpl, cache, inflight };
  const first = await fetchEismoinfoSnapshot('lt-vkr-5', { ...opts, now: 5_000 });
  assert.equal(first?.ok, true);
  assert.equal(first.contentType, 'image/jpeg');
  const second = await fetchEismoinfoSnapshot('lt-vkr-5', {
    ...opts,
    now: 5_000 + 30_000,
  });
  assert.equal(second?.ok, true);
  const featureCalls = calls.filter((row) => row.url.includes('feature-info'));
  const imageCalls = calls.filter((row) => row.url.includes('image-provider'));
  assert.equal(featureCalls.length, 1);
  assert.equal(imageCalls.length, 2);
  assert.equal(featureCalls[0].ua, EISMOINFO_USER_AGENT);
  assert.equal(imageCalls[0].ua, EISMOINFO_USER_AGENT);
  assert.equal(cctvUpstreamUserAgent(PHOTO), EISMOINFO_USER_AGENT);
  assert.equal(
    cctvUpstreamUserAgent('https://eismoinfo.lt.evil.test/camera.jpg'),
    'gods-eye-view-cctv-proxy/1.0',
  );
  calls.length = 0;
  await fetchEismoinfoSnapshot('lt-vkr-5', {
    ...opts,
    now: 5_000 + LITHUANIA_RESOLVE_CACHE_MS,
  });
  assert.equal(calls.filter((row) => row.url.includes('feature-info')).length, 1);
});

test('two viewers of one camera share one feature-info call', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let featureCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('feature-info')) {
      featureCalls += 1;
      await gate;
      return Response.json({ info: [{ photos: [PHOTO] }] });
    }
    return new Response('no', { status: 404 });
  };
  const cache = new Map();
  const inflight = new Map();
  const opts = { fetchImpl, cache, inflight, now: 10 };
  const both = Promise.all([
    resolveEismoinfoSnapshotUrl('lt-vkr-72', opts),
    resolveEismoinfoSnapshotUrl('lt-vkr-72', opts),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await both;
  assert.equal(a, PHOTO);
  assert.equal(b, PHOTO);
  assert.equal(featureCalls, 1);
});

test('CCTV_LITHUANIA_ENABLED=0 does not request the VKR list', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-lt-cctv-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const previous = process.env.CCTV_LITHUANIA_ENABLED;
  const sourcesFile = process.env.CCTV_SOURCES_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.CCTV_LITHUANIA_ENABLED;
    else process.env.CCTV_LITHUANIA_ENABLED = previous;
    if (sourcesFile === undefined) delete process.env.CCTV_SOURCES_FILE;
    else process.env.CCTV_SOURCES_FILE = sourcesFile;
  });
  process.env.CCTV_SOURCES_FILE = path.join(sourceRoot, 'missing.json');
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return new Response('unavailable', { status: 503 });
  });
  delete process.env.CCTV_LITHUANIA_ENABLED;
  await createCctvCatalog({ sourceRoot })();
  assert.equal(requested.includes(EISMOINFO_VKR_URL), true);
  requested.length = 0;
  process.env.CCTV_LITHUANIA_ENABLED = '0';
  await createCctvCatalog({ sourceRoot })();
  assert.equal(requested.includes(EISMOINFO_VKR_URL), false);
});
