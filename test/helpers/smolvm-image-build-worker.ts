/** The hardware suite owns this build's resources, including on SIGKILL. */
import { readFile } from 'fs/promises';
import { buildImageInSmolvm, type SmolvmImageBuildOptions } from '../../src/vm/smolvm-image-build';
import { smolvmCliRunner } from '../../src/vm/smolvm-docker-machine';
import { hardwareTestEnv } from './hardware-env';

const [binary, plan, ...argv] = process.argv.slice(2) as [string, string, ...string[]];
try {
  const prepare = Bun.spawn([...argv, '--build-plan', plan], { env: hardwareTestEnv(), stdout: 'inherit', stderr: 'inherit', timeout: 600_000 });
  const code = await prepare.exited;
  if (code !== 0) throw new Error(`prepare the daemon image build exited ${code}`);
  const options = JSON.parse(await readFile(plan, 'utf8')) as Pick<SmolvmImageBuildOptions, 'checkout' | 'output' | 'platform' | 'builderImage' | 'allowCidrs'>;
  await buildImageInSmolvm({ ...options, cleanupOwner: 'caller', run: smolvmCliRunner(binary), say: line => console.log(line) });
} catch (err) {
  console.error(`smolvm hardware image build failed: ${String(err)}`);
  process.exitCode = 1;
}
