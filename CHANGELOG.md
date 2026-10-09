# Changelog

All notable changes to this project will be documented in this file.

## [v0.6.1] - 2026-10-08

* **9.05, 11.40 & 11.60**: Added missing offsets to fix Poops support.
  *(Note: Relapse remains unsupported on 9.05 and 11.40)*

## [v0.6.0] - 2026-10-07

### Unified Architecture & Upstream Remote Loader Base
* **Single Shared Base**: WebKit Autoloader is now built on top of [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader), unifying the userland exploit runner, ROP primitives, and payload pipeline across both Poops and Relapse.
* **Developer Iteration & Contributions**: Developers looking to experiment with, test, or improve Poops or Relapse can now do so easily in [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader) by loading payloads over the network (port 9027). Any improvements made in that repo can be contributed upstream to directly benefit both projects.

### Dropped umtx2 (FW <= 5.50)
* **Dropped Legacy umtx2 Support**: Support for firmwares 1.00–5.50 via umtx2 has been dropped in this release. That path was not receiving updates and was blocking development and architectural changes.
* **Future Lower Firmware Support**: Support for lower firmwares may be added back in the future if it is added to [ps5-webkit-remote-loader](https://github.com/itsPLK/ps5-webkit-remote-loader). Contributions to bring lower firmware support to the new unified base are welcome!

### Exploit & Stability Improvements
* **Relapse Stability**: Stability and reliability improvements for the Relapse chain.

---
For changelogs of previous releases, see [GitHub Releases](https://github.com/itsPLK/ps5-webkit-autoloader/releases).

