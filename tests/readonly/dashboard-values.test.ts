// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { KUBE_DASHBOARD_URL, TERMINAL_NAME, dashboardRequestSchema, dashboardResponseSchema, isNodeAKS, isAKSCluster, findDashboardPodArguments, projectDashboardPod } from '../../src/shared/dashboard-protocol.ts';
const node = (name: string, roleLabel: string) => ({ name, roleLabel });
test('the URL and terminal name are upstream verbatim', () => {
  assert.equal(KUBE_DASHBOARD_URL, 'http://localhost:8001/ui/');
  assert.equal(TERMINAL_NAME, 'Kubernetes Dashboard');
});
test('the AKS heuristics are upstream verbatim including the empty-list quirk', () => {
  assert.equal(isNodeAKS(node('aks-agentpool1-123', 'agent')), true);
  assert.equal(isNodeAKS(node('aks-agentpool1-123', 'control-plane')), false);
  assert.equal(isNodeAKS(node('minikube', 'agent')), false);
  assert.equal(isAKSCluster([node('aks-a-1', 'agent'), node('aks-b-2', 'agent')]), true);
  assert.equal(isAKSCluster([node('aks-a-1', 'agent'), node('minikube', 'agent')]), false);
  assert.equal(isAKSCluster([]), true); // upstream for-loop over zero nodes returns true — quirk preserved and disclosed
});
test('the dashboard-pod invocation is verbatim and the projection keeps the first-item shape with explicit errors', () => {
  assert.deepEqual(findDashboardPodArguments(), ['get', 'pod', '-n', 'kube-system', '-l', 'k8s-app=kubernetes-dashboard', '-o', 'json']);
  const pod = { metadata: { name: 'kubernetes-dashboard-abc' }, spec: { containers: [{ livenessProbe: { httpGet: { port: 8443, scheme: 'HTTPS' } } }] } };
  assert.deepEqual(projectDashboardPod([pod]), { name: 'kubernetes-dashboard-abc', port: 8443, scheme: 'HTTPS' });
  assert.throws(() => projectDashboardPod([]), /DASHBOARD_POD_MALFORMED/);
  assert.throws(() => projectDashboardPod([{ metadata: {}, spec: {} }]), /DASHBOARD_POD_MALFORMED/);
  assert.throws(() => projectDashboardPod([{ metadata: { name: 'p' }, spec: { containers: [{ livenessProbe: { httpGet: { port: 0, scheme: 'HTTPS' } } }] } }]), /DASHBOARD_POD_MALFORMED/);
  assert.throws(() => projectDashboardPod([{ metadata: { name: 'p' }, spec: { containers: [{ livenessProbe: { httpGet: { port: 8443, scheme: 'TCP' } } }] } }]), /DASHBOARD_POD_MALFORMED/);
});
test('the bounded request/response pair carries the heuristic result and URL', () => {
  assert.equal(dashboardRequestSchema.safeParse({ protocol: 2, kind: 'read', nodes: [node('aks-a', 'agent')] }).success, true);
  assert.equal(dashboardRequestSchema.safeParse({ protocol: 2, kind: 'read', nodes: [] }).success, true);
  for (const bad of [{ nodes: 'x' }, { nodes: [{ name: '', roleLabel: 'agent' }] }, { nodes: Array.from({ length: 513 }, () => node('aks-a', 'agent')) }, { nodes: [], extra: 1 }]) assert.equal(dashboardRequestSchema.safeParse({ protocol: 2, kind: 'read', ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(dashboardResponseSchema.safeParse({ protocol: 2, kind: 'dashboard-checked', aks: true, url: KUBE_DASHBOARD_URL }).success, true);
  assert.equal(dashboardResponseSchema.safeParse({ protocol: 2, kind: 'dashboard-checked', aks: false, url: 'x'.repeat(129) }).success, false);
  assert.equal(dashboardResponseSchema.safeParse({ protocol: 2, kind: 'dashboard-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(dashboardResponseSchema.safeParse({ protocol: 2, kind: 'dashboard-unavailable', code: 'NOPE' }).success, false);
});
