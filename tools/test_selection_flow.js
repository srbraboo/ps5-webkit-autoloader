// The chain choice must survive the whole round trip, and only be asked when
// firmware genuinely supports both chains.
//
// This is the invariant the installer depends on:
//   pick in the installer page -> stored on the origin -> the pointer sends the
//   user to that chain's page -> that page runs that chain's exploit
//
// The property this file pins hardest: BOTH chain pages are always cached, so a
// chain switch is one storage key and touches nothing in the AppCache. Every
// earlier failure in this area came from mechanisms that tried to make the cache
// depend on the choice.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const FW = [
  // fw,      poops, relapse  (as the installer page computes it)
  ['7.00', true, true], ['7.61', true, true], ['8.60', true, true],
  ['9.00', true, true], ['9.05', true, false], ['9.60', true, true],
  ['10.01', true, true], ['11.00', true, true], ['11.40', true, false],
  ['12.00', true, true], ['12.02', false, true], ['12.70', false, true],
  ['13.00', false, true], ['13.60', false, true],
];

/* ---- installer page: frontend/installer-page/index.html ------------------- */

function loadPage(options) {
  const html = fs.readFileSync('frontend/installer-page/index.html', 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replaceAll('[[VERSION_PLACEHOLDER]]', 'test-version');
  const nodes = Object.fromEntries(['status', 'repair', 'choice', 'poops', 'relapse', 'progress', 'percent', 'detail', 'progressBar', 'logContainer',
    'cacheCorruptOverlay', 'cancelRepair', 'repairMessage']
    .map(key => [key, { hidden: true, className: '', textContent: '', style: {}, focus() {},
      setAttribute(key, value) { this[key] = String(value); },
      removeAttribute(key) { delete this[key]; } }]));
  nodes.status.textContent = 'Caching content...';
  nodes.progress['aria-valuenow'] = '0';
  const saved = new Map(Object.entries(options.seed || {}));
  const listeners = {};
  const requests = [];
  const logRequests = [];
  let swaps = 0;
  let target;
  const sandbox = {
    URLSearchParams,
    XMLHttpRequest: function () {
      this.open = (method, path) => { this.path = path; };
      this.send = () => { logRequests.push(this); };
      this.abort = () => { this.aborted = true; };
      this.getResponseHeader = () => '42';
    },
    document: { getElementById: key => nodes[key] },
    navigator: { userAgent: options.fw ? 'PlayStation 5/' + options.fw : 'Mozilla/5.0' },
    localStorage: {
      getItem: key => (saved.has(key) ? saved.get(key) : null),
      setItem: (key, value) => { saved.set(key, value); },
      removeItem: key => { saved.delete(key); },
    },
    location: { search: options.search || '', pathname: '/', replace: p => { target = p; } },
    confirm: () => !!options.confirm, setTimeout: () => {},
    fetch: async (path) => {
      requests.push(path);
      if (path.endsWith('__complete__')) return { text: async () => options.incomplete ? 'wrong' : 'test-version' };
      return { ok: !options.requestFails };
    },
    applicationCache: options.noCache ? undefined : {
      UNCACHED: 0, UPDATEREADY: 4, CACHED: 5,
      status: options.status === undefined ? 4 : options.status,
      addEventListener: (event, fn) => { listeners[event] = fn; },
      swapCache() { if (this.status !== this.UPDATEREADY) throw new Error('The object is in an invalid state'); swaps++; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { nodes, listeners, saved, requests, logRequests, swaps: () => swaps, target: () => target };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

/* ---- pointer page: frontend/pointer/index.html ----------------------------- */

function loadPointer(options) {
  const html = fs.readFileSync('frontend/pointer/index.html', 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replaceAll('[[VERSION_PLACEHOLDER]]', 'test-version')
    .replaceAll('[[APP_DIR_PLACEHOLDER]]', 'test-version');
  const nodes = { status: { textContent: '' } };
  const saved = new Map(Object.entries(options.seed || {}));
  let target;
  const sandbox = {
    document: { getElementById: key => nodes[key] },
    localStorage: { getItem: key => (saved.has(key) ? saved.get(key) : null) },
    location: { replace: path => { target = path; } },
    fetch: async () => ({ text: async () => (options.incomplete ? 'wrong' : 'test-version') }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { nodes, target: () => target };
}

const only = fw => {
  const row = FW.find(r => r[0] === fw);
  return row[1] && !row[2] ? 'poops' : !row[1] && row[2] ? 'relapse' : null;
};

(async () => {
  // 1. dual-chain firmware asks on a bare load, and nothing may cache behind the
  //    prompt: the page registers no AppCache handlers at all, and the server
  //    withholds the manifest attribute, so the progress bar cannot race the
  //    buttons.
  for (const fw of FW.filter(r => r[1] && r[2]).map(r => r[0])) {
    for (const pick of ['poops', 'relapse']) {
      const page = loadPage({ fw });
      assert.equal(page.nodes.choice.hidden, false, fw + ': should ask');
      assert.equal(Object.keys(page.listeners).length, 0,
        fw + ': nothing may cache while the prompt is up');
      page.nodes[pick].onclick();
      assert.equal(page.saved.get('wkal_pending'), pick, fw + ': did not record ' + pick);
      // The reload is what starts the cache: the server serves the manifest
      // attribute only when the request carries a supported choice.
      const params = new URLSearchParams(page.target().split('?')[1]);
      assert.equal(params.get('exploit'), pick, fw + ': must reload with the choice');

      // ...and that reload must cache, with no prompt.
      const after = loadPage({ fw, search: '?exploit=' + pick });
      assert.equal(after.nodes.choice.hidden, true, fw + ': must not ask again');
      assert(Object.keys(after.listeners).length > 0, fw + ': caching must start after the choice');
    }
  }

  // 2. lone-chain firmware never asks and stores that chain on its own
  for (const fw of FW.filter(r => !(r[1] && r[2])).map(r => r[0])) {
    const chain = only(fw);
    const page = loadPage({ fw });
    assert.equal(page.nodes.choice.hidden, true, fw + ': must not ask');
    assert.equal(page.saved.get('wkal_pending'), chain, fw + ': should record ' + chain);
    assert(Object.keys(page.listeners).length > 0,
      fw + ': a single-chain console must cache without a prompt');
  }

  // 3. unsupported firmware refuses outright and signals /exit to the server
  const dead = loadPage({ fw: '5.50' });
  assert.match(dead.nodes.status.textContent, /Unsupported/);
  assert.equal(dead.saved.get('wkal_exploit'), undefined);
  assert(dead.requests.includes('/exit'), 'unsupported firmware must request /exit to stop the installer daemon');

  // 4. a saved choice is honoured, but the prompt still appears so switching is
  //    always available -- as before the refactor, where the prompt was driven by
  //    the query string alone and a stored choice never suppressed it.
  for (const installed of ['poops', 'relapse']) {
    const page = loadPage({ fw: '11.00', seed: { wkal_exploit: installed } });
    assert.equal(page.nodes.choice.hidden, false, 'an installed choice must not suppress the prompt');
    assert.match(page.nodes.detail.textContent, new RegExp('Currently installed: ' + installed));
    // Choosing records the intent as pending and must not touch the installed
    // one: a failed install must not leave the app with no chain at all.
    const other = installed === 'poops' ? 'relapse' : 'poops';
    page.nodes[other].onclick();
    assert.equal(page.saved.get('wkal_pending'), other, 'the click must record a pending choice');
    assert.equal(page.saved.get('wkal_exploit'), installed,
      'the installed choice must survive until the install finishes');
  }
  // The reload keeps the intent pending; it is not promoted until /install says so.
  const mid = loadPage({ fw: '11.00', search: '?exploit=relapse', seed: { wkal_exploit: 'poops' } });
  assert.equal(mid.saved.get('wkal_pending'), 'relapse');
  assert.equal(mid.saved.get('wkal_exploit'), 'poops', 'must not promote before /install succeeds');
  // ...and one this firmware cannot run is replaced by the only chain that works.
  const stale = loadPage({ fw: '13.60', seed: { wkal_exploit: 'poops' } });
  assert.equal(stale.saved.get('wkal_pending'), 'relapse',
    'an unusable chain must be replaced, not left to fail later');
  assert.equal(stale.nodes.choice.hidden, true, 'a single-chain console should not be asked');

  // 5. after the choice, install waits only for the cache. The choice can no
  //    longer arrive late, because caching cannot start without it.
  for (const event of ['cached', 'noupdate', 'updateready']) {
    const page = loadPage({ fw: '11.00', search: '?exploit=poops' });
    page.listeners[event]();
    await flush();
    assert.deepEqual(page.requests, ['/app/test-version/__complete__', '/install'],
      event + ': should install once the cache completes');
    assert.equal(page.saved.get('wkal_exploit'), 'poops', 'the choice must be recorded');
  }

  // 6. the pointer sends the user to the chain they chose
  for (const chain of ['poops', 'relapse']) {
    const pointer = loadPointer({ seed: { wkal_exploit: chain } });
    await flush();
    assert.equal(pointer.target(), '/app/test-version/' + chain + '.html');
  }
  const unmarked = loadPointer({});
  await flush();
  assert.equal(unmarked.target(), undefined, 'no choice means no redirect');
  assert.match(unmarked.nodes.status.textContent, /installer again/);

  // 7. both chain pages are always cached, so switching costs nothing
  const registry = fs.readFileSync('tools/gen_file_registry.py', 'utf8');
  assert(!/selected_exploit/.test(registry),
    'gen_file_registry.py must not list selected_exploit; the choice is not cached');
  // Checked in the Makefile as well as the generated manifest: the manifest on
  // disk is a stale build artifact and would hide a change to staging.
  const makefile = fs.readFileSync('Makefile', 'utf8');
  assert(/for chain in \$\(CHAINS\)/.test(makefile) &&
    /cp build\/autoloader\/\$\$chain\.html \$\(STAGE\)\/app\/\$\(BUILD_VERSION\)\/\$\$chain\.html/.test(makefile),
  'the Makefile must stage every chain page, or a switch would need a cache update');
  const dist = 'frontend/dist/cache.appcache';
  if (fs.existsSync(dist)) {
    const manifest = fs.readFileSync(dist, 'utf8');
    for (const chain of ['poops', 'relapse']) {
      assert(manifest.includes('/' + chain + '.html'),
        chain + '.html must be a CACHE entry, or a chain switch would need a cache update');
    }
  }

  // 8. The server may look at the request, but must hold no selection *state*.
  //    A remembered choice is what got wiped mid-download and came back stale;
  //    everything here is recomputed from the query string and User-Agent.
  const httpServer = fs.readFileSync('src/http_server.c', 'utf8');
  for (const gone of ['selected_exploit', 'active_exploit', '# selected exploit']) {
    assert(!httpServer.includes(gone), 'src/http_server.c still references ' + gone);
  }
  assert(!/^static atomic_int .*exploit/m.test(httpServer),
    'the server must not keep a remembered choice');
  for (const present of [
    // The definition, not just the call site: a call whose helper was never
    // added is a compile error, and it slipped through once already.
    'static int supported_chains(struct MHD_Connection *conn) {',
    'int poops = fw >= 7 && fw <= 12;',
    'int relapse = fw >= 7 && fw <= 13.60f && fw != 9.05f && fw != 11.40f;',
    'int cache_allowed = chains != 0 && (single_chain || (requested & chains) != 0);',
    'if (entry_page && !cache_allowed) {',
  ]) {
    assert(httpServer.includes(present),
      'src/http_server.c should still gate the manifest per request: ' + present);
  }

  console.log('Selection flow passed: picks stored and honoured, no prompt on lone-chain firmware, ' +
    'both chain pages cached so a switch never invalidates anything.');
})().catch(error => { console.error(error); process.exitCode = 1; });
