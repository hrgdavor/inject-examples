const { execSync } = require('child_process');
try {
  const result = execSync('npm test', { encoding: 'utf8' });
  console.log(result);
} catch (e) {
  console.error(e.stdout || '');
  console.error(e.stderr || '');
  process.exit(e.status ?? 1);
}
