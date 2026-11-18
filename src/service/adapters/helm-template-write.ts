// WORKSPACE-WRITE chain: a single new-file write of the converted template into the canonical
// workspace chart's templates directory. The exclusive 'wx' flag refuses to overwrite atomically
// (DOCUMENT_DIRTY — upstream TODO admits the existence check is missing). Never invoked by
// automated functional tests. No cluster, no resource mutation, no auto-open.
import { mkdir, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import { workspaceChartDirectory } from '../../shared/helm-convert-protocol.ts';
export type HelmTemplateWriteRun = (input: { readonly root: string; readonly path: string; readonly name: string; readonly text: string }, signal: AbortSignal) => Promise<void>;
export function createHelmTemplateWriteRunner(): HelmTemplateWriteRun {
  return async (input, signal) => {
    if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    const chartDirectory = workspaceChartDirectory(input.root, input.path);
    const templatesDirectory = posix.join(chartDirectory, 'templates');
    await mkdir(templatesDirectory, { recursive: true }); // chart templates directory only
    const destination = posix.join(templatesDirectory, `${input.name}.yaml`);
    try {
      await writeFile(destination, input.text, { flag: 'wx' }); // exclusive: never overwrite
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BoundaryError('DOCUMENT_DIRTY');
      throw error;
    }
  };
}
