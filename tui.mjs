import { runTui } from './presentation/tui.mjs';
export * from './presentation/tui.mjs';

import { pathToFileURL } from 'node:url';
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runTui().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
