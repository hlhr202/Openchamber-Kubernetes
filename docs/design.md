# Resource Tree Design and Visual Acceptance

Match the node structure and compact layout of `Clusters` and `Helm Repos` in VS Code Kubernetes `1.4.1`. The OpenChamber shell, host theme and language, and the type icons specified below need not be pixel-identical. Place context or repository rows directly under the view heading. Do not add a same-named root node or replace the tree with cards or a flat list.

## Tree Structure

The active context shows these groups in order. Inactive contexts cannot be expanded.

| Group | Children, in order |
| --- | --- |
| Namespaces | Namespace leaves; the current namespace starts with `* ` |
| Nodes | Each node contains the Pods on that node |
| Workloads | Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, Pods |
| Network | Services, Endpoints, Ingress |
| Storage | Persistent Volumes, Persistent Volume Claims, Storage Classes |
| Configuration | Config Maps, Secrets; expanding an object shows only its data keys |
| Custom Resources | Plural type label, then instances; distinguish same-named types in tooltips without adding an API group level |
| Helm Releases | Release, then revision; show status and relative time in the description |

Put matching Pods directly under their controller or Service without an extra `Pods` level. Do not add a Jobs level under CronJob. Pod status and readiness counts appear in one informational leaf, with the IP in another. `Helm Repos` uses repository, chart, then version. Chart labels omit the repository prefix. Versions are leaves with descriptions and app versions in tooltips. Keep the English group names, capitalization, plurality, and spacing unchanged.

## Rows, Themes, and Interaction

- Keep rows compact and single-line. Align chevrons, icons, labels, descriptions, and trailing actions to measured widths and baselines. Check rows with and without icons separately. Truncate long names and show the full text in a tooltip without changing row height or indentation. Flip menus and tooltips near edges so they stay in the panel.
- Choose icons from the context or resource type without making extra queries. Preserve status icons and semantic colors when Deployment, Pod, or Helm status is available. Type icons adapt to the theme. Use shape and text as well as color to convey status.
- Distinguish hover, focused selection, unfocused selection, and keyboard focus. Pair the host selection background with its selection text color, and show the focus outline only for `:focus-visible`. Show inline actions and context menu entries only on applicable nodes. Buttons must not crowd out the main text. Make loading, empty, failed, and stale states distinguishable without fabricating resources or health status.
- Use the host language except for group names. Describe uses concise explanations and safe text highlighting. Preserve keyboard, high-contrast, zoom, and assistive technology support. On narrow screens, the tree and detail views share one column. On wide screens, the outer split is adjustable. See the [Explorer spec](./features/9-resource-explorer-ux-and-request-control/spec.md).

## Visual Baseline and Acceptance

Use a pinned official stable version of VS Code, extension `1.4.1`, the default light and dark themes, default fonts, icons, and tree settings, and 100% zoom. Record exact versions, platform, device pixel ratio, view dimensions, theme, and accessibility settings. Source code establishes node and menu semantics. Measure geometry in the actual Workbench rather than inferring it from source, mockups, or other plugins. Without reliable screenshots or measurements, leave the result unverified.

Use identical nonsensitive data, fixed relative timestamps, and equivalent CSS widths and zoom. Record scroll, expansion, selection, focus, hover, and menu state. Keep the originals and matching crops; do not stretch them. Compare the title toolbar, row heights and text baselines, indentation, chevron and icon columns, labels and descriptions, inline actions, and state popups. Allow only 1 CSS px of rounding error in key positions or dimensions, with no cumulative drift. Record host shell, theme, language, font rasterization, and specified icon differences separately; they must not conceal structural or geometric discrepancies.

| ID | Scenario and checks |
| --- | --- |
| V01 | Clusters title, active and inactive contexts, root row alignment and chevrons |
| V02 | All default groups, order, type icons, indentation, and cumulative row height below the fold |
| V03 | Namespace leaves, current namespace marker `* `, and alignment |
| V04 | Node, controller, or Service to Pod; deep expansion and alignment of like rows |
| V05 | Pod statuses, readiness, and IP; missing data does not imply health |
| V06 | Config Map and Secret key layout; no values in rows or screenshots |
| V07 | Custom resource type labels, same-named types, and instance hierarchy |
| V08 | Helm releases and revisions, status and time, icons, and tooltips |
| V09 | Helm repositories, chart prefixes, version leaves, and tooltips |
| V10 | Hover, focused and unfocused selection, keyboard focus, chevrons, and action visibility |
| V11 | Inline actions and menu conditions, order, grouping, size, and anchors; do not run actions |
| V12 | Long names, nesting depth, scrolling, narrow and wide modes, and the splitter |
| V13 | Distinct loading, empty, failed, and stale states without changing the resource hierarchy |
| V14 | Light and dark themes, icon contrast, host language, and assistive technology |

Automated visual verification uses presentation-only fixtures in Docker, disconnected from real executors. Use prepared data for Helm. Do not trigger authentication, cache refresh, configuration changes, or operations. A person independently verifies the real host and records the installed candidate ID, source, environment, screenshots, differences, and pass, fail, or not-run status for each scenario. Functional tests or synthetic screenshots do not cover unverified visual scenarios. When the candidate changes, retest affected scenarios.
