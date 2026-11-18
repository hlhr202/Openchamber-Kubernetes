import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleConfigurations, bundledDependencies, developmentSourcePath, panelAssets } from '../../scripts/compile.ts';
import { verifyBundlePaths } from '../../scripts/check-static.ts';
import { summarizeSamples, workerReportSchema } from '../../scripts/benchmark-model.ts';
import { inspectWatchContract } from '../../scripts/toolchain-contract.ts';

test('release/development share exact dual targets while separating minification and source maps', () => {
  for (const profile of ['release', 'development'] as const) {
    const options = bundleConfigurations('/controlled/stage', profile, '1.2.3', '/controlled/source');
    assert.equal(options.length, 2);
    assert.equal(options[0]?.platform, 'browser');
    assert.equal(options[1]?.platform, 'node');
    assert.equal(options[1]?.transform?.define?.__K8S_EXTENSION_VERSION__, '"1.2.3"');
    assert.equal(options[0]?.transform?.define?.__K8S_EXTENSION_VERSION__, undefined);
    for (const option of options) {
      assert.equal(option.cwd, '/controlled/source');
      const output = option.output;
      assert.ok(output && !Array.isArray(output));
      assert.equal(output.minify, profile === 'release');
      assert.equal(output.sourcemap, profile === 'development');
      assert.ok(!option.plugins, 'no build hook imports/executes the product entry');
    }
    const browser = options[0]?.output;
    assert.ok(browser && !Array.isArray(browser));
    assert.equal(browser.format, 'iife');
    assert.equal(browser.codeSplitting, false);
    const service = options[1]?.output;
    assert.ok(service && !Array.isArray(service));
    assert.equal(service.format, 'esm');
    const external = options[1]?.external;
    assert.equal(typeof external, 'function');
    if (typeof external === 'function') {
      assert.equal(external('node:fs', undefined, false), true);
      assert.equal(external('yaml', undefined, false), false);
      assert.equal(external('./private-runtime.ts', undefined, false), false);
    }
  }
  assert.deepEqual(panelAssets, ['index.html', 'main.css', 'icon.svg']);
  assert.deepEqual(bundledDependencies, ['@openchamber/sdk', 'zod', 'yaml', '@xterm/xterm', '@xterm/addon-serialize']);
});

test('benchmark summaries use all finite samples and median, not only the fastest result', () => {
  assert.deepEqual(summarizeSamples([9, 1, 5]), { samples: [9, 1, 5], minimum: 1, median: 5, maximum: 9 });
  assert.equal(summarizeSamples([10, 2, 8, 4]).median, 6);
  for (const samples of [[], [NaN], [Infinity], [-1]]) assert.throws(() => summarizeSamples(samples));
  assert.equal(workerReportSchema.safeParse({ kind: 'compile', samples: [] }).success, false);
  assert.equal(workerReportSchema.safeParse({ kind: 'typecheck', samplesMs: [1], controllerPeakRssBytes: 1, freshNativeProcessesPerSample: 4, arbitrary: true }).success, false);
});

test('development source markers never weaken release or runtime literal path checks', () => {
  const marker = '// ../../workspace/node_modules/yaml/index.js\nconst value = 1;';
  assert.throws(() => verifyBundlePaths(marker));
  verifyBundlePaths(marker, 'development');
  for (const code of ['const a="/workspace/private/file";', 'const a=`\n// ../../workspace/node_modules/yaml/index.js\n`;', '// /Users/example/file', '// /workspace/private/file']) {
    assert.throws(() => verifyBundlePaths(code, 'development'));
  }
  assert.equal(developmentSourcePath('../src/panel/entry.ts', '/source/out/main.js.map', '/source'), 'project/src/panel/entry.ts');
  assert.equal(developmentSourcePath('/workspace/node_modules/.pnpm/yaml/node_modules/yaml/index.js', '/out/main.js.map', '/source'), 'dependencies/yaml/index.js');
  assert.throws(() => developmentSourcePath('/unknown/private.ts', '/out/main.js.map', '/source'));
});

test('the exact pinned watch API is recorded as experimental rather than assumed stable', async () => {
  const contract = await inspectWatchContract();
  assert.equal(contract.package, 'rolldown');
  assert.equal(contract.version, '1.2.15');
  assert.match(contract.sha256, /^[a-f0-9]{64}$/);
  assert.equal(contract.experimental, true);
});
