import path from "node:path";

export interface ServerConfig {
    /** TCP port to listen on. Env: PORT (default 3300). */
    port: number
    /** Host to bind. Env: HOST (default 127.0.0.1, local tool). */
    host: string
    /** Root data directory. Env: THGRID_DATA_DIR (default <repo>/data). */
    dataDir: string
    /** Directory with the built web UI, served statically when present. Env: THGRID_WEB_DIST. */
    webDist: string
}

/** Repository root, resolved relative to this file whether it runs from `src/` (tsx) or `dist/` (tsc). */
export const repoRoot = path.resolve(__dirname, '..', '..')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    const port = Number(env.PORT ?? 3300)
    if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PORT: ${env.PORT}`)
    return {
        port,
        host: env.HOST ?? '127.0.0.1',
        dataDir: path.resolve(env.THGRID_DATA_DIR ?? path.join(repoRoot, 'data')),
        webDist: path.resolve(env.THGRID_WEB_DIST ?? path.join(repoRoot, 'web', 'dist')),
    }
}

export const dataLayout = {
    templates: 'templates',
    collections: 'collections',
    networks: 'networks',
} as const
