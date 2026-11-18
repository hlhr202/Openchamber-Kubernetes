import assert from 'node:assert/strict';
import { readonlyTestFiles } from './readonly-tests.ts';
import { staticTestFiles } from './static-tests.ts';

export type TestSuite = 'readonly' | 'static';
export const suiteFiles = { readonly: readonlyTestFiles, static: staticTestFiles };

// Only reviewed text assertions and pure value tests share a process. New files
// start isolated; this list never discovers tests by directory or filename pattern.
const batches = {
  static: [
    ['helm-version-wiring', 'helm-refresh-wiring', 'helm-inspect-wiring', 'helm-values-wiring', 'helm-dependencies-wiring', 'helm-lint-wiring', 'helm-template-wiring'],
    ['helm-dryrun-wiring', 'helm-package-wiring', 'helm-depup-wiring', 'helm-create-wiring', 'helm-fetch-wiring', 'helm-requirement-wiring', 'helm-convert-wiring'],
    ['helm-parameterise-wiring', 'helm-get-wiring', 'helm-install-wiring', 'helm-uninstall-wiring', 'helm-rollback-wiring', 'helm-release-wiring', 'helm-cluster-write-wiring'],
    ['helm-template-preview-wiring', 'helm-command-source-review', 'helm-repository-wiring', 'helm-discovery-wiring', 'helm-semver-wiring'],
  ],
  readonly: [
    ['helm-version-values', 'helm-refresh-values', 'helm-inspect-values', 'helm-values-values', 'helm-dependencies-values', 'helm-lint-values', 'helm-template-values'],
    ['helm-dryrun-values', 'helm-package-values', 'helm-depup-values', 'helm-create-values', 'helm-fetch-values', 'helm-requirement-values', 'helm-convert-values'],
    ['helm-parameterise-values', 'helm-get-values', 'helm-release-values', 'helm-install-values', 'helm-uninstall-values', 'helm-rollback-values', 'helm-template-preview-values'],
    ['terminal-values', 'exec-values', 'port-forward-values'],
    ['scale-values', 'cronjob-run-values', 'expose-values', 'config-file-delete-values', 'config-file-add-values', 'file-delete-values'],
    ['dashboard-values', 'show-sessions-values', 'minikube-status-values', 'minikube-start-values', 'minikube-stop-values', 'select-pod-values', 'find-local-tunnel-providers-values'],
    ['remove-debug-values', 'save-kubeconfig-values', 'create-cluster-values', 'configure-from-cluster-values', 'debug-local-tunnel-values', 'merge-kubeconfig-values', 'debug-attach-values'],
  ],
} as const;

export function testBatches(suite: TestSuite) {
  const allowed: readonly string[] = suiteFiles[suite];
  assert.equal(new Set(allowed).size, allowed.length, 'Duplicate suite allowlist entry');
  const batched = new Set<string>();
  const groups = batches[suite].map(batch => batch.map(name => {
    const path = `tests/${suite}/${name}.test.ts`;
    assert.ok(allowed.includes(path) && !batched.has(path), `Unexpected batch entry: ${path}`);
    batched.add(path);
    return path;
  }));
  return { groups, isolated: allowed.filter(path => !batched.has(path)), sourceCount: allowed.length };
}
