# Product Scope

Browse, inspect, edit, and operate on Kubernetes resources from an OpenChamber project workspace. Use the pinned VS Code Kubernetes `1.4.1` source as the baseline for tree nodes, ordering, expansion behavior, and the scope of each action. Where host capabilities differ, provide equivalent behavior and disclose the differences.

## Initial Release Scope

- `Clusters` covers browsing, inspection, logs and observation, resource and kubeconfig management, and `Helm Releases`. `Helm Repos` covers browsing and fetching repositories and charts, plus workspace operations. Release operations target a specific release or version.
- The scope includes container Terminal and Exec, Port Forward, Dashboard, Debug, Local Tunnel, and cluster creation or onboarding through supported providers. It excludes a separate `Clouds` view and a general-purpose server command runner.
- Each capability must connect applicable nodes and parameter selection to actual execution, results, errors, and any necessary refresh or cleanup. Placeholder buttons, printed commands, or registered handlers alone do not count. See the [feature specs](./README.md) for capabilities and non-goals.

## Support Boundaries

- Pin the official OpenChamber `2.5.1` release and SDK `2.5.1`. Use only public interfaces, without host changes or custom builds. Server targets are macOS arm64 and Linux x64. Clients include the macOS desktop app and supported web browsers, including connections to remote servers. A target platform is not a claim of runtime acceptance.
- A trusted single-user instance can span devices and uses the server OS user's identity. It does not promise tenant isolation. Tools, workspace files, applications, and debuggers live on the server; there is no client agent. User-provided dependencies must be discoverable and usable. Report missing or incompatible dependencies without automatic installation, login, or environment changes.
- Local Tunnel uses Telepresence. The user prepares the client, Traffic Manager, and permissions. Operations that may change traffic or inject an agent require explicit user intent and disclosure of their impact.

## Interaction and Safety

- Tree group names stay in English; the rest of the interface follows the host language and theme. See the [design spec](./design.md) for tree structure, the visual baseline, and allowed differences.
- Browsing does not authorize a write. Resource, configuration, and file changes bind to explicit user intent and the actual target. Switching projects, contexts, or namespaces must not redirect an operation. Do not replay unknown results or proceed with dependent steps. Cancellation does not undo a submitted action.
- View Secrets directly under existing permissions without a second confirmation. Do not show values in tree rows. Credentials, resource contents, and session output do not enter ordinary preferences or history and are not sent to chat or third parties automatically. An explicit Save or Export is not implicit persistence.

## Delivery Criteria

Record source integration, automated Docker checks, real execution, and visual acceptance separately. A person verifies the actual installed candidate, platform, and result for each entry point in a non-production environment. Synthetic data and Linux builds do not replace evidence from a real host or macOS. Automated verification follows the [hard limits](./README.md#hard-limits).
