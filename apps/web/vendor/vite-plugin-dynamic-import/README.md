# Temporary dynamic-import dependency patch

This is MIT-licensed `vite-plugin-dynamic-import` 1.6.0 from upstream commit
`d419182b6e22a29e79203cc83193adf16d364da7`, with `fast-glob` replaced by
`tinyglobby`. Matches are ordered by depth, then path, preserving file-before-index
resolution. This removes the `micromatch` → `braces` dependency chain while keeping
Vinext's CommonJS tooling functional. The full npm audit remains enabled.

Patched source commit: `977ba7baad5be9c73a072a142858dcc0bd4ca387`.

Source repository: https://github.com/vite-plugin/vite-plugin-dynamic-import

`src/` contains the patched source. `lib/` contains its upstream Vite build output
(normally named `dist/`), including declarations, so `npm ci --ignore-scripts`
works in the production Docker build without compiling a dependency at install
time. Only packaging paths and the local version suffix differ from upstream.
The root web dependency and its npm override deliberately resolve to this same
local package. Runtime dependencies remain recorded and audited in the web lockfile.

To regenerate: apply the upstream patch to the commit above, install its frozen
Yarn lockfile, run `npm run build && npm test`, and copy `src/` and `dist/` into
this package's `src/` and `lib/`. Keep the MIT license with both source and output.
`scripts/build-plugin.test.mjs` tests the actual installed CommonJS consumer,
including dynamic requires, nested modules and file/index precedence.
Vendored third-party source is excluded from the application TypeScript/lint
project; its types and behavior are checked by the upstream build and tests.

Once upstream publishes this change, remove the local dev dependency, override
and vendor directory; regenerate the web lockfile, remove the vendor Docker COPY
and allowlist entries, then rerun tests, both builds and the full audit.
