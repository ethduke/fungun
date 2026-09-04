import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { configureReadServiceProxy } from './lib/dev-read-proxy.mjs';
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  compatibility_flags: ['nodejs_compat'],
};

export default defineConfig(async ({ command }) => {
  const apiPort = Number(process.env.READ_SERVICE_PORT || 8787);
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535)
    throw new Error('Invalid local read-service port.');
  if (process.env.FUNGUN_WEB_TARGET === 'fly') {
    return {
      css: { postcss: { plugins: [tailwindcss()] } },
      plugins: [vinext()],
      build: { sourcemap: false },
    };
  }
  // Keep preview runtime files out of the user's global directories.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      host: '127.0.0.1',
      strictPort: true,
      proxy: {
        '^/api/(catalog|ticker|fees|claim-prepare|tracked-prices)(?:[/?]|$)': {
          target: `http://127.0.0.1:${apiPort}`,
          rewrite: (path: string) => path.replace(/^\/api(?=\/)/, '/v1'),
          configure: configureReadServiceProxy,
        },
      },
      watch: isCodexSeatbeltSandbox
        ? { useFsEvents: false, usePolling: true }
        : undefined,
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        inspectorPort: false,
        remoteBindings: false,
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: {
          ...localBindingConfig,
          ...(command === 'serve'
            ? {
                vars: Object.fromEntries(
                  [
                    'APP_ORIGIN',
                    'ASSET_SERVICE_ORIGIN',
                    'ASSET_PUBLIC_ORIGIN',
                    'ASSET_UPLOADS',
                    'ASSET_STORAGE',
                    'PINATA_GATEWAY',
                    'IMAGE_USDG_ADDRESS',
                  ]
                    .filter((name) => typeof process.env[name] === 'string')
                    .map((name) => [name, process.env[name]!]),
                ),
              }
            : {}),
        },
      }),
    ],
  };
});
