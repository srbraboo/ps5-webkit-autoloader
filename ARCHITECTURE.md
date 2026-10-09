# WebKit Autoloader architecture

This repository installs an offline homescreen app and bundles a standalone HTML
page built by `third_party/ps5-webkit-remote-loader`. Remote-loader owns WebKit,
firmware offsets, the ROP worker, Poops, Relapse, and the standalone runtime.
It also owns the shared native installer helpers and SDK Docker recipe. This
repository provides `include/installer_config.h` for its app name, title ID,
assets and log prefix. Remote-loader has no dependency on this repository.
The installer has a small exploit chooser and cache progress bar. The exploit
runs directly in the standalone page, without an iframe or generated-code patches.

## Runtime

`tools/build_standalone.py` builds **one standalone page per chain**, and each
page carries three ordinary payloads. The loader first prepares the WebKit memory
primitive and ROP worker, then runs this queue:

1. `elfldr-check.js` connects to `127.0.0.1:9021` without sending data. If a loader
   accepts the connection, it requests `api.stopQueue()`, closes its socket, and
   skips both remaining payloads. A refused connection allows the queue to proceed;
   an unexpected probe or cleanup error stops it instead of retrying a kernel
   exploit blindly. No kernel access is required for this check.
2. `poops.js` (or `relapse.js`) runs unmodified from the submodule. It establishes
   kernel access and brings up elfldr/kexp itself on port 9021.
3. `autoload.js` then stages the bundled ELF into an anonymous mapping and streams
   it to elfldr. It selects nothing: the page is already built for one chain.

The payload queue runs in order: `[1/3] elfldr-check.js`, `[2/3] poops.js`
(or `relapse.js`), then `[3/3] autoload.js`. Each payload runs directly in the page
context without wrappers.

The installation flow is choose, then cache:

1. The installer page loads with no `?exploit=`. On firmware that supports both
   chains it shows the prompt, records nothing, and — importantly — registers no
   AppCache handlers, so nothing downloads behind the buttons.
2. The server withholds `manifest="/cache.appcache"` from the entry page until the
   request carries a supported `?exploit=`, because AppCache starts on that
   attribute and JS runs too late to stop it. Firmware with only one chain needs
   no question, so it is served with the attribute immediately.
3. Choosing records `localStorage.wkal_pending` and reloads with the choice. That
   reload is what starts the cache.
4. Once the cache completes, the page checks the `__complete__` marker and calls
   `/install`. Only on success is `wkal_pending` promoted to `wkal_exploit` and
   cleared.

Two keys, so the one the pointer reads means "an install completed". A choice is
never written over the installed one on the way in, so a failed install leaves the
previous autoloader intact and launchable; only a finished `/install` changes what
is installed. This is also what makes "Currently installed: X" in the prompt
truthful rather than "whatever was last clicked".

Both chain pages are cached once caching starts, so switching later costs nothing
and never re-downloads anything.

The server's part is decided strictly per request, from the query string and the
User-Agent, without maintaining server-side state or remembered choices.

**Both chain pages are always cached (~9.4 MB uncompressed).** The cached bytes
therefore do not depend on the choice, so switching chains changes one storage key
and touches nothing in the AppCache — there is no cache to invalidate. This is
deliberate and load bearing: caching both pages at once makes subsequent chain
switches instant and offline, with zero network or cache invalidation risk.

The server's only selection logic is deciding per request whether to include the
`manifest="/cache.appcache"` attribute on `/index.html`. It stores no selection state
in memory or C variables.

The upstream firmware table rejects unsupported firmware before running WebKit.
Supported versions are the remote-loader offset tables in the 7.00–13.60 range.
Poops works without an active network interface; Relapse needs a connected local
network interface, but no Internet access.

## Build

`Makefile` calls the upstream builders without transforming their output:

- `make page`: verify/download dependencies, then call `tools/build_standalone.py`
  once per chain with `payloads/elfldr-check.js`, that chain's exploit, then
  `payloads/autoload.js::<payload_elf>`, plus
  `--elfldr` and `--embed <payload_elf>=<file>`. Outputs: `build/autoloader/{poops,relapse}.html`.
  The exploits are submodule paths, resolved relative to the submodule root.
- `make all`: stage the installer page, stable pointer and generated HTML; generate
  a compressed C registry and AppCache manifest; compile `installer.elf` with the
  PS5 SDK. Both installers compile remote-loader's `installer/common` sources;
  product-specific main loops and HTTP routing stay in their own repositories.
  Docker provides the SDK and libmicrohttpd from remote-loader's Docker recipe.
- `make host HOST_PAYLOAD=<installer.elf>`: build standalone setup pages for both
  chains (Relapse and Poops) embedding that installer, then package them via
  remote-loader's `tools/build_host.py` into `webkit-autoloader-host.py`. At runtime,
  the host serves Relapse by default and automatically routes firmwares incompatible
  with Relapse (9.05, 11.40) to Poops.
  Use a versioned ELF path outside the native `installer.elf` target when building
  the host on a machine without the SDK.
- `make dev`: serve the generated chain pages on localhost:8123.
- `make clean`: remove generated pages, registry and unversioned artifacts; retain
  verified downloads in `build/deps/` for offline rebuilds.

`PAGE_CSS` and `PAGE_JS` default to `frontend/autoloader/style.css` and `app.js`,
providing the log panel, progress bar, and status footer on both chain pages and the
PC setup page. The script moves the existing console into the panel and observes
its log lines for progress; it never wraps the exploit or replaces its APIs.
Completion waits for the queue summary, including payload cleanup. An existing
ELF loader is shown as already running, and failures stay visible in the log.
`tools/gen_version.py --page-config` supplies the footer's version and build time
as an inline startup script. No additional network resources are needed.

Override `PAGE_CSS` and `PAGE_JS` to pass other files to the upstream HTML builder.
CSS is embedded after the default styles in the
head. Each JavaScript file runs in its own async function before module boot and
the exploit; use top-level `await` or return a promise for work that must finish
first. Multiple files run in argument order, and startup errors stop boot.

```sh
make page PAGE_CSS=path/to/theme.css PAGE_JS=path/to/setup.js
# Or build the upstream plain console:
make page PAGE_CSS= PAGE_JS=
```

The variables accept whitespace-separated lists of paths relative to the working
directory. Startup scripts can prepare the DOM and share state through `window`;
they have no payload `api`. Inline assets needed during offline startup. This
keeps appearance changes in CSS/JS files here instead of rewriting generated HTML
or changing the exploit sources.

`tools/download_deps.sh` downloads the pinned itsPLK elfldr and unified-autoloader
release assets, caching verified digest sidecars. kexp is the binary bundled by
remote-loader. Submodule initialization is non-recursive: remote-loader's nested
copy of this repository is not a build input.

`build_release.sh` pins `BUILD_VERSION` once across Docker, HTML/cache generation,
and PC host packaging, then writes versioned ELF/Python artifacts. GitHub Actions
also packages the Python host as a Windows executable.

Remote-loader changes live on `refactor/minimal-autoloader`: `--embed URL=FILE`
adds inline fetch resources, `--elfldr [URL=]FILE` overrides the loader binary without
editing generated HTML, and the host builder accepts `--page` and `--name`.
Its probe verifies embedded file sizes and input digests, including external assets.

The target payload ELF (`ps5-unified-autoloader` for offline autoloader pages, or
the installer ELF for the PC setup host) is embedded via `--embed`.

## Offline installation

The installer serves on `127.0.0.1:18181` only. On dual-chain firmwares, its browser
page prompts the user to select Poops or Relapse before starting caching. Choosing
reloads with `?exploit=<chain>`, allowing the HTTP server to include the manifest
attribute. The page displays AppCache download progress and calls `/install` once
caching completes (`cached`, `noupdate`, or `updateready`). Upon successful install,
`wkal_pending` is promoted to `wkal_exploit` in `localStorage`. The installer validates
the version marker before creating the shortcut. Cache errors leave the installer
running and offer a user-confirmed WebKit-data clear; the native installer then
reopens the browser to retry.

The cache layout is:

```text
/index.html                  installer/cache entry
/logo.svg                    installer logo asset
/cache.appcache              generated manifest
/app/index.html              stable homescreen pointer
/app/<version>/poops.html    chain page: elfldr-check.js, poops.js, then autoload.js
/app/<version>/relapse.html  chain page: elfldr-check.js, relapse.js, then autoload.js
/app/<version>/__complete__  version marker, last in CACHE
```

The pointer checks the marker before navigating, then sends the user to the chain
page they chose, so partial cache downloads cannot start the app. The HTTP server
serves the standalone chain pages verbatim. It withholds the installer's manifest
attribute until a supported choice is present, as described above.

`SIMULATE=1|2` and `tools/build_cache_corruption_test_elfs.sh` are available for
hardware testing of failed-cache repair.

## Verification

`make test-native` runs remote-loader's common native helper tests on Linux (or
inside the SDK container). PS5 services are stubbed and all `/user` filesystem
operations are redirected into a temporary tree. The tests cover installation
and updates with two app configurations, embedded resources, service errors,
notifications, browser launch, foreground-user cleanup, long-log truncation and
raw DEFLATE. Native ELF compilation still uses the PS5 SDK.

`make test` runs the four offline suites. `tools/test_elfldr_check.js` drives the
real check payload through the upstream queue, verifying accepted/refused sockets,
descriptor cleanup, and skipping the remaining payloads on a stop or unexpected
probe failure. `tools/test_autoload_payload.js` covers
the third payload: ELF staging into the mapping, the hand-off to elfldr, short
socket writes, the missing-`krw` refusal and cleanup on failure.
`tools/test_installer.js` checks the installer's cache events, the marker gate,
choice gating in both orders, error handling, repair confirmation and the pointer.
`tools/test_selection_flow.js` checks that a pick is stored on the origin and that
the pointer routes to the matching chain page, that lone-chain firmware neither
prompts nor leaves the choice unset, and that both chain pages are staged and
cached so a switch never invalidates anything.

Upstream `third_party/ps5-webkit-remote-loader/tools/probe_standalone.js` and
`tools/boot_probe.js` check the generated HTML, inline resources, modules, firmware
offsets and boot order. `SIMULATE=1|2` builds and
`tools/build_cache_corruption_test_elfs.sh` cover failed-cache repair.

None of this can establish exploit reliability; that needs a PS5 hardware run.
