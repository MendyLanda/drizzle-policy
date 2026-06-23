const { mkdirSync, writeFileSync } = require('node:fs');

mkdirSync('lib/cjs', {
  recursive: true,
});

writeFileSync('lib/cjs/package.json', '{"type":"commonjs"}\n');
