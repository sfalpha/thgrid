import express, {Express, NextFunction, Request, Response} from "express";
import fs from "node:fs";
import path from "node:path";
import {dataLayout, ServerConfig} from "./config";
import {TemplateStore} from "./storage/template.store";
import {CollectionStore} from "./storage/collection.store";
import {TemplateService} from "./services/template.service";
import {CollectionService} from "./services/collection.service";
import {metaRouter} from "./routes/meta";
import {templatesRouter} from "./routes/templates";
import {collectionsRouter} from "./routes/collections";
import {networksRouter} from "./routes/networks";
import {NetworkStore} from "./storage/network.store";
import {NetworkService} from "./services/network.service";
import {ErrorResponse, HttpError} from "./errors";

export interface AppContext {
    config: ServerConfig
    templates: TemplateStore
    collections: CollectionStore
    networks: NetworkStore
    templateService: TemplateService
    collectionService: CollectionService
    networkService: NetworkService
}

export const APP_VERSION = '0.1.0'

export async function createContext(config: ServerConfig): Promise<AppContext> {
    const templates = new TemplateStore(path.join(config.dataDir, dataLayout.templates))
    const collections = new CollectionStore(path.join(config.dataDir, dataLayout.collections))
    const networks = new NetworkStore(path.join(config.dataDir, dataLayout.networks))
    await Promise.all([templates.init(), collections.init(), networks.init()])
    return {
        config,
        templates,
        collections,
        networks,
        templateService: new TemplateService(templates, collections),
        collectionService: new CollectionService(templates, collections),
        networkService: new NetworkService(networks),
    }
}

export function createApp(ctx: AppContext): Express {
    const app = express()
    app.disable('x-powered-by')
    app.use(express.json({limit: '50mb'}))

    app.get('/api/health', (_req, res) => {
        res.json({ok: true, version: APP_VERSION, dataDir: ctx.config.dataDir})
    })
    app.use('/api/meta', metaRouter(APP_VERSION))
    app.use('/api/templates', templatesRouter(ctx.templateService))
    app.use('/api/collections', collectionsRouter(ctx.collectionService))
    app.use('/api/networks', networksRouter(ctx.networkService))

    app.use('/api', (_req, res) => {
        res.status(404).json({error: {code: 'NOT_FOUND', message: 'Unknown API route'}} satisfies ErrorResponse)
    })

    // Built web UI (npm run build). In development Vite serves the UI and proxies /api here.
    const indexHtml = path.join(ctx.config.webDist, 'index.html')
    if (fs.existsSync(indexHtml)) {
        app.use(express.static(ctx.config.webDist))
        app.get('*', (_req, res) => {
            res.sendFile(indexHtml)
        })
    } else {
        app.get('/', (_req, res) => {
            res.type('text/plain').send(
                'thgrid API is running. The web UI has not been built: run "npm run build" and restart, ' +
                'or run "npm run dev" and open the Vite URL.\n'
            )
        })
    }

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        if (err instanceof HttpError) {
            const body: ErrorResponse = {error: {code: err.code, message: err.message}}
            if (err.code === 'VALIDATION_FAILED') body.error.issues = (err.details as { issues: ErrorResponse['error']['issues'] }).issues
            else if (err.details !== undefined) body.error.details = err.details
            res.status(err.status).json(body)
            return
        }
        const anyErr = err as { type?: string; status?: number; message?: string }
        if (anyErr?.type === 'entity.parse.failed') {
            res.status(400).json({error: {code: 'BAD_JSON', message: anyErr.message ?? 'Malformed JSON body'}} satisfies ErrorResponse)
            return
        }
        console.error(err)
        res.status(500).json({error: {code: 'INTERNAL', message: 'Internal server error'}} satisfies ErrorResponse)
    })

    return app
}
