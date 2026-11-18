import { spawn } from 'node:child_process';
import { requireDevelopmentContainer } from './development.ts';

requireDevelopmentContainer();
const configs = ['shared', 'service', 'panel', 'scripts'];
for (const config of configs) {
  const status = await new Promise<number>((resolve, reject) => {
    // The documented stable single-threaded mode is reproducible in the current emulated x64 container.
    const child = spawn('node_modules/.bin/tsc', ['--project', `tsconfig.${config}.json`, '--noEmit', '--singleThreaded'], { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  if (status !== 0) process.exit(status);
}
