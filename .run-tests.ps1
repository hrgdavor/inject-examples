$script = @'
const { execSync } = require('child_process');
try {
  const result = execSync('npm test', { encoding: 'utf8' });
  console.log(result);
} catch (e) {
  console.error(e.stdout);
  console.error(e.stderr);
  process.exit(e.status);
}
'@
$script | Out-File -Encoding utf8 D:\wrk\utils\inject-examples\.run-tests.ps1
node .\ .run-tests.ps1
