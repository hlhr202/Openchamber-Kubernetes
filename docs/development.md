# Isolated Development and Verification

Use a Docker environment, development image, and dependency volumes prepared by a person. Follow the [hard limits](./README.md#hard-limits).

```sh
docker compose run --rm --no-deps --pull never dev node scripts/in-container.ts check:foundation
```

- `check:foundation` freezes the project inputs, runs type checks, lint, and allowlisted read-only and static tests, then builds and statically verifies the candidate. It does not run the plugin, Chromium checks, or independent ZIP readback. Do not modify inputs while checks run.
- Reviewed text assertions and pure value tests share small, explicitly listed Node runners. All other suites retain per-file isolation. The report records wall time by stage. To compare with per-file execution, run `node scripts/run-tests.ts <readonly|static> isolated` in the prepared Docker `dev` container from the project root.
- `typecheck`, `lint`, `test:readonly`, `check:baseline`, `build:development`, `bench:build`, and `package:zip` can run separately. For Chromium checks, run `prepare:ui-refresh`, then load the static fixture in a network-isolated container.
- `node scripts/develop.ts check:foundation` can freeze inputs before starting the container. Run it sequentially so no two invocations write the same snapshot. It uses `/var/empty` for Docker configuration and defaults to `unix:///var/run/docker.sock`. The operator can set `K8S_DEVELOPMENT_DOCKER_HOST` to another Unix socket. It does not read host Docker login configuration.

## Environment and Artifacts

- The `dev` container is Linux x64, runs as non-root with a read-only root filesystem and no network, and listens on no ports. Dependencies, the store, and `HOME` use dedicated volumes. The image is defined in `docker/dev.Dockerfile`. Prepare dependencies through the `prepare` profile with a frozen lockfile and install hooks disabled by default. Do not install dependencies on the host.
- `bootstrap` only prepares an isolated synthetic environment. It does not import plugin operation code and is not a feature smoke test. Routine checks do not start it.
- `.build/candidates/`, `.build/packages/`, and `.build/reports/` contain candidates, ZIPs, and verification reports, respectively. A candidate pointer is not proof of installation. See [build and verification](./architecture.md#build-and-verification) for artifact identity and verification boundaries.
- `bench:build` holds inputs fixed, runs separately, and reports time, size, and peak memory. A separate process does not imply a cold system cache; repeated builds are not incremental rebuilds. Linux container results do not prove macOS compatibility or real host responsiveness.

## README Screenshots

The four English desktop screenshots in `docs/screenshots/` are documentation assets, not part of the install package. All README translations use these files. The screenshot fixture renders production views and styles with fixed synthetic state and a preview frame. It cannot access a host bridge and does not run a cluster read, terminal, or forwarding operation.

```sh
mkdir -p .build/readme-gallery
docker compose --env-file /dev/null run --rm --no-deps --pull never dev \
  node scripts/in-container.ts prepare:readme-screenshots
docker run --rm --pull never --platform linux/amd64 --network none --read-only \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,size=256m -e HOME=/tmp \
  -v "$PWD/.build/reports/readme-screenshots:/preview:ro" \
  -v "$PWD/.build/readme-gallery:/output" \
  -v "$PWD/scripts/capture-readme-screenshots.py:/capture.py:ro" \
  mcr.microsoft.com/playwright@sha256:42f02d323c310069b4d54c94bd91a608966a486c3492c48ae0b1cea747ec5ca2 python3 /capture.py
```

Review the four 1680 × 945 PNGs in `.build/readme-gallery/` before copying them to `docs/screenshots/`. Do not use real cluster images or add the browser output directory to Git.

## Git URL Installation

OpenChamber `2.5.1` clones the repository's default branch when the URL has no branch or tag fragment. It inspects the root manifest and its prebuilt files; it does not install npm dependencies, compile the extension, or look up a GitHub Release asset. Keep `package.json` at the repository root and publish the files it references at their manifest-relative paths. For an update, increase the root manifest's `version` and publish it with the matching build. A ZIP remains a separate installation option.

Build and verify the candidate in the prepared, network-isolated Docker image:

```sh
docker compose run --rm --no-deps --pull never dev node scripts/in-container.ts check:foundation
```

Then, on the host, from the repository root with an existing Node 24 installation:

```sh
node scripts/git-install.ts prepare
node scripts/git-install.ts check
```

The host script uses only Node built-ins. It checks the Docker foundation report, current source fingerprint, candidate file hashes, and root manifest before exporting `panel/{index.html,main.css,icon.svg,main.js}`, `service/main.js`, and `THIRD_PARTY_NOTICES.txt`. It preserves the root `package.json` and `LICENSE`. The `check` mode compares the published bytes without rewriting them. This is a copy integrity check, not a substitute for Docker testing. Run the tasks sequentially and do not edit inputs during publication. Commit the six generated files with the matching source and version, but not `.build/`, `dist/`, `node_modules/`, or ZIPs. Neither task commits, pushes, or installs the extension.
