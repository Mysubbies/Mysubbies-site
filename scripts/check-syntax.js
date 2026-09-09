const { readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');
const { tmpdir } = require('os');

function filesUnder(dir, suffix) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, suffix));
    else if (path.endsWith(suffix)) out.push(path);
  }
  return out;
}

function check(source, label) {
  const temp = join(tmpdir(), `mysubbies-syntax-${process.pid}-${Math.random()}.js`);
  writeFileSync(temp, source);
  const result = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
  unlinkSync(temp);
  if (result.status !== 0) throw new Error(`${label}\n${result.stderr}`);
}

for (const file of [...filesUnder('api', '.js'), ...filesUnder('test', '.js'), __filename]) {
  check(readFileSync(file, 'utf8'), file);
}

for (const file of readdirSync('.').filter(name => name.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8').replace(/<!--[^]*?-->/g, '');
  const scripts = html.matchAll(/<script([^>]*)>([^]*?)<\/script>/gi);
  let index = 0;
  for (const match of scripts) {
    index++;
    const attrs = match[1];
    if (/\bsrc\s*=/.test(attrs) || /type\s*=\s*["']application\/(?:ld\+)?json["']/i.test(attrs)) continue;
    check(match[2], `${file} inline script ${index}`);
  }
}

console.log('JavaScript and executable inline HTML scripts passed syntax checks.');
