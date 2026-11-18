# Release and Verification Status

## GitHub Release

For manual installation of [v1.0.0](https://github.com/hlhr202/Openchamber-Kubernetes/releases/tag/v1.0.0), use the attached `openchamber-kubernetes-v1.0.0.zip`, not GitHub's automatically generated source archive. Git URL installation uses the prebuilt files on `main` instead.

The release is verified in Docker. This does not certify installation on a real OpenChamber host or Kubernetes operation coverage. See the [author's tested workflows](../README.md#what-the-author-tested).

## Earlier Local Candidate

- Candidate ID: `m2-06f2ddae993436b281b7ebc54b190be9f7ca88d52a05e3a402e33fa368322e72`. Source fingerprint: `eee400f779e92c384ac322013692fc60e88297df7e3a53c42c6062ccf58b6e9e`.
- Installation ZIP: `.build/packages/m2-06f2ddae993436b281b7ebc54b190be9f7ca88d52a05e3a402e33fa368322e72/package.zip`. It contains 8 entries, is 504,658 bytes, and has SHA-256 `4f1306cb609c40482b57b7e8a557b6481a4829cf3f65b1605451dd96d32eea96`. This is a local build artifact, not part of a clean checkout.
- This candidate includes Custom Resources metadata pagination, the wide-screen splitter, and resource type icons. Docker verification passed 1,632 read-only and pure-model tests, 860 static tests, offline Chromium checks, the build, and independent ZIP integrity checks. Reports in `.build/reports/`: `custom-workbench-delivery.log`, `custom-workbench-browser.log`, and `custom-workbench-zip-verification.json`.
- The ZIP was not installed on a real host and no cluster was contacted. These results apply only to the listed candidate and verification scope.
