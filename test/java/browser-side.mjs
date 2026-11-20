// Node (like a browser) against the Java LanServer started by LanHarness: node browser-side.mjs <port>
const port = process.argv[2];
const base = `http://127.0.0.1:${port}`;
let fails = 0;
const ok = (c, w) => {
  console.log((c ? '  ok   ' : '  FAIL ') + w);
  if (!c) fails++;
};
const page = await fetch(`${base}/`);
ok(page.headers.get('content-type')?.includes('text/html') && (await page.text()).includes('__KUNET_LOCAL__'), 'browser GET / → html with script');
const js = await fetch(`${base}/assets/app.js`);
ok(js.status === 200 && js.headers.get('content-type')?.includes('javascript') && js.headers.get('cache-control').includes('immutable'), 'asset with type and long cache');
ok((await fetch(`${base}/sw.js`)).status === 404, 'sw.js is not served');
ok((await fetch(`${base}/assets/%2e%2e%2f%2e%2e%2fsecret.txt`)).status !== 200, 'no path escape');
ok((await fetch(`${base}/missing.png`)).status === 404, 'missing file 404');
ok((await (await fetch(`${base}/somewhere`)).text()).includes('__KUNET_LOCAL__'), 'extensionless path gets the app');
const created = await (await fetch(`${base}/api/rooms?pid=pp`, { method: 'POST', body: '{}' })).json();
ok(created.code === 'ABCD', 'POST /api/rooms (with a body)');
const many = await Promise.all(Array.from({ length: 30 }, () => fetch(`${base}/api/rooms/ABCD`).then((r) => r.json())));
ok(many.every((m) => m.exists === true), '30 parallel info requests');
await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/ABCD/ws?pid=web1`);
  const msgs = [];
  ws.onmessage = (e) => {
    msgs.push(String(e.data));
    if (msgs.length === 1) ws.send('{"t":"ping"}');
    if (msgs.length === 2) {
      ok(msgs[0] === 'open:ABCD:web1' && msgs[1] === 'echo:{"t":"ping"}', 'browser WebSocket frames');
      ws.send('bye');
    }
  };
  ws.onclose = (e) => {
    ok(e.code === 4000, `browser sees close code 4000 (got ${e.code})`);
    resolve();
  };
  ws.onerror = () => {
    ok(false, 'ws error');
    resolve();
  };
});
process.exitCode = fails ? 1 : 0;
