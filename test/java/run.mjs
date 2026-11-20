// Compiles the plugin's pure-Java server/client with a JDK and runs both halves of the check.
//   node test/java/run.mjs [path-to-jdk-bin]   (default: KUNET_JDK env, then ../android-toolchain)
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const here = import.meta.dirname;
const repo = resolve(here, '..', '..');
const jdk = process.argv[2] ?? process.env.KUNET_JDK ?? resolve(repo, '..', 'android-toolchain', 'jdk', 'jdk-21.0.13+9', 'bin');
const exe = (n) => join(jdk, process.platform === 'win32' ? `${n}.exe` : n);

const work = mkdtempSync(join(tmpdir(), 'kunet-java-'));
const web = join(work, 'web');
mkdirSync(join(web, 'assets'), { recursive: true });
writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>hi</body></html>');
writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
writeFileSync(join(work, 'secret.txt'), 'secret');
const classes = join(work, 'classes');

const src = join(repo, 'android', 'src', 'main', 'java', 'com', 'kunet', 'local');
const c = spawnSync(exe('javac'), ['--release', '11', '-encoding', 'UTF-8', '-d', classes, join(src, 'LanServer.java'), join(src, 'LanClient.java'), join(here, 'LanHarness.java')], { stdio: 'inherit' });
if (c.status !== 0) process.exit(1);

const java = spawn(exe('java'), ['-Dfile.encoding=UTF-8', '-cp', classes, 'LanHarness', web], { stdio: ['ignore', 'pipe', 'inherit'] });
let buf = '';
const port = await new Promise((ok, fail) => {
  java.stdout.on('data', (d) => {
    buf += d;
    process.stdout.write(d);
    const m = buf.match(/READY (\d+)/);
    if (m) ok(m[1]);
  });
  java.on('exit', (code) => fail(new Error(`java exited ${code}`)));
});
const node = spawnSync(process.execPath, [join(here, 'browser-side.mjs'), port], { stdio: 'inherit' });
java.kill();
process.exit(node.status ?? 1);
