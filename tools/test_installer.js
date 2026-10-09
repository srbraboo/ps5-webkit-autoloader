// Exercise cache completion, failures, repair and the pointer without a PS5.
//
// The installer's two prerequisites are independent -- the AppCache completing
// and an exploit being chosen -- and may arrive in either order, so both orders
// and the "one never arrives" cases are covered.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(file, options = {}) {
  const html = fs.readFileSync(file, 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replaceAll('[[VERSION_PLACEHOLDER]]', 'test-version')
    .replaceAll('[[APP_DIR_PLACEHOLDER]]', 'test-version');
  const nodes = Object.fromEntries(['status', 'repair', 'choice', 'poops', 'relapse', 'progress', 'percent', 'detail', 'progressBar', 'logContainer',
    'cacheCorruptOverlay', 'cancelRepair', 'repairMessage']
    .map(key => [key, { hidden: true, className: '', textContent: '', style: {}, focus() {},
      setAttribute(key, value) { this[key] = String(value); },
      removeAttribute(key) { delete this[key]; } }]));
  // Seed the text the markup starts with, so a handler that writes nothing is
  // distinguishable from one that writes the expected message.
  nodes.status.textContent = 'Caching content...';
  nodes.progress['aria-valuenow'] = '0';
  const requests = [];
  const logRequests = [];
  const listeners = {};
  let swaps = 0;
  let target;
  const saved = new Map(Object.entries(options.seed || {}));
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
    location: {
      search: options.search || '', pathname: '/', replace: path => { target = path; },
    },
    confirm: () => !!options.confirm,
    setTimeout: () => {},
    fetch: async path => {
      requests.push(path);
      if (path.endsWith('__complete__')) return { text: async () => options.incomplete ? 'wrong' : 'test-version' };
      return { ok: !options.requestFails };
    },
    applicationCache: options.noCache ? undefined : {
      // Real AppCache states. A re-run over an existing cache fires updateready
      // without necessarily leaving the cache in UPDATEREADY, and swapCache()
      // then throws InvalidStateError.
      UNCACHED: 0, CHECKING: 1, DOWNLOADING: 2, UPDATEREADY: 4, CACHED: 5, OBSOLETE: 3,
      status: options.status === undefined ? 4 : options.status,
      addEventListener: (event, fn) => { listeners[event] = fn; },
      swapCache() {
        if (this.status !== this.UPDATEREADY) {
          const error = new Error('The object is in an invalid state');
          error.name = 'InvalidStateError';
          throw error;
        }
        swaps++;
        this.status = this.CACHED;
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { nodes, requests, logRequests, listeners, swaps: () => swaps, target: () => target, saved };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

// The state the installer is in *after* a choice: the page was reloaded with a
// supported ?exploit=, so there is no prompt and the cache is running. The
// pre-choice state (prompt up, nothing caching) is covered separately below.
const dual = options => setup('frontend/installer-page/index.html',
  { fw: '11.00', search: '?exploit=poops', ...options });

(async () => {
  // After the choice, the cache alone is enough to install.
  for (const event of ['cached', 'noupdate', 'updateready']) {
    for (const status of [4, 5]) {
      const test = dual({ status });
      test.listeners[event]();
      test.listeners[event]();
      await flush();
      assert.deepEqual(test.requests, ['/app/test-version/__complete__', '/install'],
        event + ' at status ' + status + ': should install');
      assert.equal(test.swaps(), event === 'updateready' && status === 4 ? 1 : 0,
        event + ' at status ' + status + ': unexpected number of swaps');
      assert.match(test.nodes.status.textContent, /Installed/);
      assert.equal(test.nodes.status.className, 'success');
      assert.equal(test.nodes.progress.className, 'success');
      assert.equal(test.logRequests[0].aborted, true, 'stop polling when the server shuts down');
      test.listeners.cached();
      assert.equal(test.nodes.progress.className, 'success', 'late cache events must preserve success');
    }
  }

  // Before the choice, nothing may cache at all: no AppCache handlers are
  // registered and no request is made, so the progress bar cannot race the
  // buttons. The server withholds the manifest attribute in this state too.
  const before = setup('frontend/installer-page/index.html', { fw: '11.00' });
  assert.equal(before.nodes.choice.hidden, false, 'a bare load must prompt');
  assert.equal(before.nodes.progress.hidden, true, 'no progress bar behind the prompt');
  assert.equal(Object.keys(before.listeners).length, 0, 'nothing may cache behind the prompt');
  assert.deepEqual(before.requests, []);
  assert.deepEqual(before.logRequests, [], 'no log polling while choosing');
  // Clicking records the choice and reloads with it; that reload starts the cache.
  before.nodes.poops.onclick();
  assert.equal(new URLSearchParams(before.target().split('?')[1]).get('exploit'), 'poops');
  const after = dual();
  assert(Object.keys(after.listeners).length > 0, 'the reload must start the cache');
  assert.equal(after.nodes.choice.hidden, true, 'the reload must not prompt again');
  assert.equal(after.logRequests[0].path, '/logs?pos=0');
  after.logRequests[0].status = 200;
  after.logRequests[0].responseText = '[WKALI] Caching content\n';
  after.logRequests[0].onload();
  assert.equal(after.nodes.logContainer.hidden, false);
  assert.match(after.nodes.logContainer.textContent, /Caching content/);

  // A choice already stored does not suppress the prompt, so switching stays one
  // tap away -- but the prompt is still what starts the cache, so it names the
  // current choice rather than silently keeping it.
  const rerun = setup('frontend/installer-page/index.html',
    { fw: '11.00', search: '?exploit=relapse', seed: { wkal_exploit: 'poops' } });
  rerun.listeners.cached();
  await flush();
  assert.equal(rerun.saved.get('wkal_exploit'), 'relapse', 'a finished install must promote it');
  assert.equal(rerun.saved.get('wkal_pending'), undefined, 'pending must be cleared');

  // A failed install must leave the previous one intact and usable.
  const failed = setup('frontend/installer-page/index.html',
    { fw: '11.00', search: '?exploit=relapse', seed: { wkal_exploit: 'poops' }, requestFails: true });
  failed.listeners.cached();
  await flush();
  assert.equal(failed.saved.get('wkal_exploit'), 'poops',
    'a failed install must not clear or replace the installed chain');
  assert.equal(failed.nodes.repair.hidden, false);

  // ...and an installed choice never suppresses the prompt.
  const asked = setup('frontend/installer-page/index.html',
    { fw: '11.00', seed: { wkal_exploit: 'relapse' } });
  assert.equal(asked.nodes.choice.hidden, false, 'an installed choice must not suppress the prompt');
  assert.match(asked.nodes.detail.textContent, /Currently installed: relapse/);
  asked.nodes.poops.onclick();
  assert.equal(asked.saved.get('wkal_pending'), 'poops');
  assert.equal(asked.saved.get('wkal_exploit'), 'relapse',
    'choosing must not disturb the installed chain until the install finishes');

  // Progress is reported, and never claims 100% before the cache is complete.
  const meter = dual();
  meter.listeners.progress({ loaded: 1, total: 4 });
  assert.equal(meter.nodes.progress['aria-valuenow'], '25');
  assert.equal(meter.nodes.progressBar.style.transform, 'scaleX(0.25)');
  assert.equal(meter.nodes.percent.textContent, '25%');
  meter.listeners.progress({ loaded: 4, total: 4 });
  assert.equal(meter.nodes.progress['aria-valuenow'], '99', '100% requires completed cache');
  meter.listeners.progress({ loaded: 1, total: 0 });
  assert.equal(meter.nodes.progress['aria-valuenow'], undefined);
  assert.equal(meter.nodes.progress.className, 'indeterminate');
  meter.listeners.cached();
  await flush();
  assert.equal(meter.nodes.progress['aria-valuenow'], '100');
  assert.equal(meter.nodes.progressBar.style.transform, 'scaleX(1)');
  assert.equal(meter.nodes.progress.className, 'success');
  assert.equal(meter.nodes.percent.textContent, '100%');

  // A download that finishes but whose marker does not match is a real failure.
  for (const options of [{ incomplete: true }, { requestFails: true }]) {
    const test = dual(options);
    test.listeners.downloading();
    test.listeners.cached();
    test.nodes.poops.onclick();
    await flush();
    assert.equal(test.nodes.repair.hidden, false, 'a bad marker must offer repair');
    if (options.incomplete) assert(!test.requests.includes('/install'));
  }

  // An error during a download is corruption; one during the check is not, and
  // neither may be silent. This is the v0.5.1 behaviour.
  const during = dual();
  during.listeners.downloading();
  during.listeners.error();
  assert.equal(during.nodes.repair.hidden, false, 'a download failure must offer repair');
  assert.equal(during.nodes.cacheCorruptOverlay.hidden, false);
  assert.equal(during.nodes.status.className, 'error');
  assert.equal(during.logRequests[0].aborted, true, 'stop polling after a cache failure');
  during.nodes.cancelRepair.onclick();
  assert.equal(during.nodes.cacheCorruptOverlay.hidden, true);
  assert.deepEqual(during.requests, [], 'dismissing repair must not clear browser data');

  for (const event of ['error', 'obsolete']) {
    for (const phase of ['before', 'after']) {
      const quiet = dual();
      if (phase === 'after') {
        quiet.listeners.downloading();
        quiet.listeners.cached();
        quiet.nodes.poops.onclick();
        await flush();
        assert.match(quiet.nodes.status.textContent, /Installed/);
      }
      quiet.listeners[event]();
      await flush();
      assert.equal(quiet.nodes.repair.hidden, true,
        event + ' ' + phase + ' download must not offer WebKit-data repair');
      assert.equal(quiet.nodes.cacheCorruptOverlay.hidden, true);
      const expected = phase === 'after' ? /Installed/
        : event === 'obsolete' ? /superseded/
        : /could not be checked/;
      assert.match(quiet.nodes.status.textContent, expected,
        event + ' ' + phase + ' left the status as: ' + quiet.nodes.status.textContent);
    }
  }

  // Repair is offered but does nothing until confirmed.
  const silent = dual();
  silent.listeners.error();
  silent.nodes.repair.onclick();
  await flush();
  assert.equal(silent.requests.length, 0, 'Repair requires confirmation');

  const repair = dual({ confirm: true });
  repair.listeners.downloading();
  repair.listeners.error();
  repair.nodes.repair.onclick();
  await flush();
  assert.deepEqual(repair.requests, ['/clear-webkit-data']);
  assert.match(repair.nodes.status.textContent, /cleared/);

  // Without AppCache there is nothing to do and nothing is requested.
  const absent = dual({ noCache: true });
  assert.equal(absent.requests.length, 0);
  assert.match(absent.nodes.status.textContent, /does not support/);

  // The pointer redirects only on a complete cache and a recorded choice.
  for (const incomplete of [false, true]) {
    const pointer = setup('frontend/pointer/index.html', { incomplete, seed: { wkal_exploit: 'poops' } });
    await flush();
    assert.equal(pointer.target(), incomplete ? undefined : '/app/test-version/poops.html');
    if (incomplete) assert.match(pointer.nodes.status.textContent, /incomplete/);
  }
  const unchosen = setup('frontend/pointer/index.html', {});
  await flush();
  assert.equal(unchosen.target(), undefined, 'no choice means no redirect');
  assert.match(unchosen.nodes.status.textContent, /installer again/);

  console.log('Installer checks passed: cache events, marker, choice gating, errors, repair and pointer.');
})().catch(error => { console.error(error); process.exitCode = 1; });
