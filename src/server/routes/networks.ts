import {Request, Router} from "express";
import {NetworkChangeEvent, NetworkService} from "../services/network.service";
import {BadRequestError} from "../errors";
import {asyncHandler, queryFlag} from "./async";

/** The editor making a request (`X-Thgrid-Client`), passed into change events so it can skip its own. */
const clientOf = (req: Request): string | undefined => {
    const v = req.get('x-thgrid-client')
    return v && /^[\w-]{1,64}$/.test(v) ? v : undefined
}

/** Heartbeat of the event stream, so proxies keep it open. */
const EVENT_HEARTBEAT_MS = 25_000

/**
 * GET    /api/networks                              summaries
 * POST   /api/networks                              create { name, id?, description? }
 * POST   /api/networks/import                       upload a document (?overwrite=true, ?id=)
 * POST   /api/networks/validate                     validate a document in the body -> { valid, issues }
 * GET    /api/networks/:id                          saved document
 * DELETE /api/networks/:id                          delete (archived to history first)
 * GET    /api/networks/:id/working                  saved document + journal applied, journal state, issues
 * GET    /api/networks/:id/journal                  journal entries (?after=N: only those after seq N, with the journal state)
 * POST   /api/networks/:id/journal                  append { ops, expectedLastSeq? }
 * GET    /api/networks/:id/events                   server-sent events: one `NetworkChangeEvent` per journal append, save,
 *                                                   discard, rollback, replacing import and delete
 * DELETE /api/networks/:id/journal                  discard unsaved changes
 * POST   /api/networks/:id/save                     commit journal as a new version (?force=true ignores issues)
 * GET    /api/networks/:id/export                   document (?working=true for unsaved state, ?download=true as attachment)
 * GET    /api/networks/:id/versions                 archived versions, newest first
 * GET    /api/networks/:id/versions/:stamp          archived document
 * POST   /api/networks/:id/versions/:stamp/rollback make that version current
 * DELETE /api/networks/:id/versions                 purge history (?keep=N newest versions survive; default 0 = all)
 */
export function networksRouter(service: NetworkService): Router {
    const router = Router()

    router.get('/', asyncHandler(async (_req, res) => {
        res.json(await service.list())
    }))

    router.post('/', asyncHandler(async (req, res) => {
        const doc = await service.create(req.body)
        res.status(201).location(`/api/networks/${doc.id}`).json(doc)
    }))

    router.post('/import', asyncHandler(async (req, res) => {
        const id = typeof req.query.id === 'string' && req.query.id ? req.query.id : undefined
        const result = await service.import(req.body, {overwrite: queryFlag(req.query.overwrite), id, client: clientOf(req)})
        res.status(result.replaced ? 200 : 201).json(result)
    }))

    router.post('/validate', asyncHandler(async (req, res) => {
        const issues = service.validate(req.body)
        res.json({valid: issues.every(i => i.severity === 'warning'), issues})
    }))

    router.get('/:id', asyncHandler(async (req, res) => {
        res.json(await service.get(req.params.id))
    }))

    router.delete('/:id', asyncHandler(async (req, res) => {
        res.json({deleted: true, ...(await service.delete(req.params.id, clientOf(req)))})
    }))

    router.get('/:id/working', asyncHandler(async (req, res) => {
        res.json(await service.working(req.params.id))
    }))

    router.get('/:id/journal', asyncHandler(async (req, res) => {
        const after = req.query.after
        if (after === undefined) return void res.json(await service.journal(req.params.id))
        const n = Number(after)
        if (!Number.isInteger(n) || n < 0) throw new BadRequestError('after must be a whole number')
        res.json(await service.journalSince(req.params.id, n))
    }))

    router.post('/:id/journal', asyncHandler(async (req, res) => {
        res.json(await service.appendOps(req.params.id, req.body, clientOf(req)))
    }))

    router.delete('/:id/journal', asyncHandler(async (req, res) => {
        res.json(await service.discard(req.params.id, clientOf(req)))
    }))

    router.get('/:id/events', asyncHandler(async (req, res) => {
        const id = req.params.id
        await service.get(id)
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        })
        res.write('retry: 3000\n\n')
        const send = (event: NetworkChangeEvent) => {
            if (event.networkId === id) res.write(`data: ${JSON.stringify(event)}\n\n`)
        }
        service.events.on('change', send)
        const heartbeat = setInterval(() => res.write(': ping\n\n'), EVENT_HEARTBEAT_MS)
        req.on('close', () => {
            clearInterval(heartbeat)
            service.events.off('change', send)
        })
    }))

    router.post('/:id/save', asyncHandler(async (req, res) => {
        res.json(await service.save(req.params.id, {force: queryFlag(req.query.force), client: clientOf(req)}))
    }))

    router.get('/:id/export', asyncHandler(async (req, res) => {
        const doc = await service.export(req.params.id, {working: queryFlag(req.query.working)})
        if (queryFlag(req.query.download)) res.attachment(`${doc.id}.thgrid-network.json`)
        res.json(doc)
    }))

    router.get('/:id/versions', asyncHandler(async (req, res) => {
        res.json(await service.versions(req.params.id))
    }))

    router.delete('/:id/versions', asyncHandler(async (req, res) => {
        const raw = req.query.keep
        const keep = raw === undefined || raw === '' ? 0 : Number(raw)
        res.json(await service.purgeVersions(req.params.id, keep))
    }))

    router.get('/:id/versions/:stamp', asyncHandler(async (req, res) => {
        const doc = await service.version(req.params.id, req.params.stamp)
        if (queryFlag(req.query.download)) res.attachment(`${doc.id}.${req.params.stamp}.thgrid-network.json`)
        res.json(doc)
    }))

    router.post('/:id/versions/:stamp/rollback', asyncHandler(async (req, res) => {
        res.json(await service.rollback(req.params.id, req.params.stamp, clientOf(req)))
    }))

    return router
}
