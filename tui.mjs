import { runTui } from './presentation/tui.mjs';
export * from './presentation/tui.mjs';

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTui().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
