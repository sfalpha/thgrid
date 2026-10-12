import {Router} from "express";
import {CollectionService} from "../services/collection.service";
import {asyncHandler, queryFlag} from "./async";

/**
 * GET    /api/collections                 list (summaries)
 * POST   /api/collections                 create
 * POST   /api/collections/validate        validate without saving -> { issues }
 * POST   /api/collections/import          import a bundle (?overwrite=true)
 * GET    /api/collections/:id             collection
 * PUT    /api/collections/:id             update
 * DELETE /api/collections/:id             delete
 * GET    /api/collections/:id/export      bundle with templates embedded
 */
export function collectionsRouter(service: CollectionService): Router {
    const router = Router()

    router.get('/', asyncHandler(async (_req, res) => {
        res.json(await service.list())
    }))

    router.post('/', asyncHandler(async (req, res) => {
        const collection = await service.create(req.body)
        res.status(201).location(`/api/collections/${collection.id}`).json(collection)
    }))

    router.post('/validate', asyncHandler(async (req, res) => {
        const issues = await service.validate(req.body)
        res.json({valid: issues.length === 0, issues})
    }))

    router.post('/import', asyncHandler(async (req, res) => {
        res.status(201).json(await service.importBundle(req.body, {overwrite: queryFlag(req.query.overwrite)}))
    }))

    router.get('/:id', asyncHandler(async (req, res) => {
        res.json(await service.get(req.params.id))
    }))

    router.put('/:id', asyncHandler(async (req, res) => {
        res.json(await service.update(req.params.id, req.body))
    }))

    router.delete('/:id', asyncHandler(async (req, res) => {
        await service.delete(req.params.id)
        res.json({deleted: true})
    }))

    router.get('/:id/export', asyncHandler(async (req, res) => {
        const bundle = await service.exportBundle(req.params.id)
        if (queryFlag(req.query.download)) {
            res.attachment(`${bundle.collection.id}.thgrid-bundle.json`)
        }
        res.json(bundle)
    }))

    return router
}
