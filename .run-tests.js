// Run Node.js test suite directly via node --test
const { execSync } = require('child_process');
try {
  const result = execSync('node --test test.mjs', { encoding: 'utf8' });
  console.log(result);
} catch (e) {
  if (e.stdout) console.error(e.stdout);
  if (e.stderr) console.error(e.stderr);
  throw e;
}
