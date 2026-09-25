/**
 * 构建：加载检查全部源码模块 → 清理并复制静态资源到 dist/ → 校验入口引用 → 写入健康检查与版本信息。
 * 零依赖，Node >= 20。
 */
import { rm, mkdir, cp, copyFile, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.join(root, 'dist');

async function listJsFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

async function loadCheckSources() {
  const files = await listJsFiles(path.join(root, 'src'));
  for (const file of files) {
    // 动态导入即完成语法与依赖图加载检查（模块顶层不触碰 DOM）。
    await import(pathToFileURL(file).href);
  }
  return files.length;
}

async function checkEntryReferences() {
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  const missing = refs.filter((ref) => !existsSync(path.join(dist, ref)));
  if (missing.length > 0) {
    throw new Error(`index.html 引用了不存在的文件：${missing.join('、')}`);
  }
  return refs.length;
}

async function main() {
  const moduleCount = await loadCheckSources();

  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await copyFile(path.join(root, 'index.html'), path.join(dist, 'index.html'));
  await copyFile(path.join(root, 'styles.css'), path.join(dist, 'styles.css'));
  await cp(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true });

  const refCount = await checkEntryReferences();

  await writeFile(path.join(dist, 'health.json'), JSON.stringify({ status: 'ok' }) + '\n');
  await writeFile(path.join(dist, 'version.json'), `${JSON.stringify({
    name: 'desalination-workbench',
    builtAt: new Date().toISOString(),
    modules: moduleCount,
  }, null, 2)}\n`);

  console.log(`构建完成：${moduleCount} 个模块通过加载检查，${refCount} 处入口引用校验通过，产物位于 dist/`);
}

main().catch((err) => {
  console.error(`构建失败：${err.message}`);
  process.exit(1);
});
