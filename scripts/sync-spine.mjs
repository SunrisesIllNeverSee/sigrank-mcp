#!/usr/bin/env node
/**
 * sync-spine.mjs
 *
 * Mirrors the canonical knowledge layer from sigrank-app into sigrank-mcp.
 *
 * Source of truth: sigrank-app/observatory/, ontology/, methodology/, governance/
 * Destination:   ./observatory/, ./ontology/, ./methodology/, ./governance/
 *
 * Usage:
 *   node scripts/sync-spine.mjs              # copies from ../sigrank-app
 *   SIGRANK_APP_PATH=/path/to/app node scripts/sync-spine.mjs
 *   SIGRANK_MCP_PATH=/path/to/mcp node scripts/sync-spine.mjs
 *   node scripts/sync-spine.mjs --check      # exit 1 if dirs differ
 *   node scripts/sync-spine.mjs --dry-run    # prints what would change
 */

import { cp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';

const SPINE_DIRS = ['observatory', 'ontology', 'methodology', 'governance'];
const DST_ROOT = resolve(process.env.SIGRANK_MCP_PATH || resolve(import.meta.dirname, '..'));
const SRC_ROOT = resolve(process.env.SIGRANK_APP_PATH || resolve(DST_ROOT, '../sigrank-app'));

const DRY_RUN = process.argv.includes('--dry-run');
const CHECK = process.argv.includes('--check');

async function sha256File(path) {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex');
}

async function compareDir(srcDir, dstDir) {
  const changes = [];

  for (const file of await readdir(srcDir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const parentPath = file.parentPath || file.path;
    const rel = relative(srcDir, resolve(parentPath, file.name));
    const srcPath = resolve(srcDir, rel);
    const dstPath = resolve(dstDir, rel);

    try {
      await stat(dstPath);
      const srcHash = await sha256File(srcPath);
      const dstHash = await sha256File(dstPath);
      if (srcHash !== dstHash) {
        changes.push({ type: 'modify', rel });
      }
    } catch {
      changes.push({ type: 'add', rel });
    }
  }

  return changes;
}

async function sync() {
  let totalChanges = 0;

  for (const dir of SPINE_DIRS) {
    const src = resolve(SRC_ROOT, dir);
    const dst = resolve(DST_ROOT, dir);

    try {
      await stat(src);
    } catch {
      console.error(`Source directory does not exist: ${src}`);
      console.error('Set SIGRANK_APP_PATH to the sigrank-app repo root.');
      process.exit(1);
    }

    if (CHECK) {
      const changes = await compareDir(src, dst);
      if (changes.length > 0) {
        console.log(`[${dir}] ${changes.length} difference(s):`);
        for (const c of changes) console.log(`  ${c.type}: ${c.rel}`);
        totalChanges += changes.length;
      } else {
        console.log(`[${dir}] up to date`);
      }
      continue;
    }

    if (DRY_RUN) {
      const changes = await compareDir(src, dst);
      if (changes.length > 0) {
        console.log(`[${dir}] would update ${changes.length} file(s):`);
        for (const c of changes) console.log(`  ${c.type}: ${c.rel}`);
        totalChanges += changes.length;
      } else {
        console.log(`[${dir}] already up to date`);
      }
      continue;
    }

    try {
      await stat(dst);
      await rm(dst, { recursive: true, force: true });
    } catch {
      // destination did not exist
    }
    await cp(src, dst, { recursive: true, preserveTimestamps: true });
    console.log(`[${dir}] synced`);
  }

  if (CHECK || DRY_RUN) {
    if (totalChanges > 0) {
      console.log(`\n${totalChanges} total file(s) differ.`);
      if (CHECK) process.exit(1);
    } else {
      console.log('\nAll spine directories are in sync.');
    }
  }
}

sync().catch((err) => {
  console.error(err);
  process.exit(1);
});
