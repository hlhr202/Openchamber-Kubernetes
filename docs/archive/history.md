# History and Verification Index

This archive is not a specification, development prerequisite, or record of runtime acceptance. Historical evidence IDs are retained for traceability; a detailed activity log is not required.

- **M1–M8:** Pinned upstream evidence is kept in the `docs/baseline/` JSON files and `tests/fixtures/`. The command coverage fixture records previous candidates and review IDs by command. The earlier blanket claim of full integration based on registration or case counts was withdrawn.
- **RX-E010–E013:** Early same-project restoration failed on a real host. After workspace ownership moved to the service, synthetic viewer remounts passed in isolated Chromium. Sync deduplication, silent background sync, and draft restoration are automated evidence, not real-host acceptance.
- **Resource lists and wide-screen delivery:** Synthetic large ConfigMap, Secret, CRD definition, and custom resource instance lists showed that full LIST responses can exceed the budget. Metadata pagination regression tests passed. See the [delivered candidate](../status.md) for the package and report paths.
