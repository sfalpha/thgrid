import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(webRoot, '..')
const apiTarget = process.env.THGRID_API_URL ?? 'http://127.0.0.1:3300'

// `npm run dev:host` runs with `--mode host`: the dev server is reachable from other machines and answers any Host name
// (a Cloudflare tunnel, a LAN name, ...). Vite otherwise refuses host names other than localhost / IPs (DNS-rebinding guard).
export default defineConfig(({mode}) => ({
    root: webRoot,
    plugins: [react()],
    resolve: {
        alias: {
            // Shared domain code (templates, models) lives in the backend source tree.
            '@shared': path.join(repoRoot, 'src'),
        },
    },
    server: {
        port: 5173,
        allowedHosts: mode === 'host' ? true : undefined,
        fs: {allow: [repoRoot]},
        proxy: {
            '/api': {target: apiTarget, changeOrigin: false},
        },
    },
    build: {
        outDir: path.join(webRoot, 'dist'),
        emptyOutDir: true,
        sourcemap: true,
    },
}))
