/**
 * 一次性验证：代码测试 → 构建 → 业务模块冒烟。
 * 依次执行，任一步失败即以非零退出码结束；全部通过退出码为 0。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const steps = [
  ['代码测试', ['--test', 'tests/**/*.test.mjs']],
  ['构建', ['scripts/build.mjs']],
  ['业务模块冒烟', ['scripts/smoke.mjs']],
];

for (const [name, args] of steps) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nVERIFY FAIL：「${name}」未通过`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nVERIFY PASS：测试、构建、冒烟全部通过');
