import {Router} from "express";
import {TemplateService} from "../services/template.service";
import {asyncHandler, queryFlag} from "./async";
import {isTemplateKind} from "../../templates/template";
import {BadRequestError} from "../errors";

/**
 * GET    /api/templates                     list all kinds   (?kind=K to filter; ?data=true: whole records)
 * GET    /api/templates/:kind               list one kind    (?data=true: whole records, data included)
 * POST   /api/templates/:kind               create
 * POST   /api/templates/:kind/validate      validate without saving -> { issues }
 * GET    /api/templates/:kind/:id           record
 * PUT    /api/templates/:kind/:id           update
 * DELETE /api/templates/:kind/:id           delete (?force=true)
 * GET    /api/templates/:kind/:id/usage     who references it
 * GET    /api/templates/:kind/:id/resolved  factory-ready form (references embedded)
 */
export function templatesRouter(service: TemplateService): Router {
    const router = Router()

    router.get('/', asyncHandler(async (req, res) => {
        const kindParam = req.query.kind
        if (kindParam !== undefined) {
            if (typeof kindParam !== 'string' || !isTemplateKind(kindParam)) throw new BadRequestError(`Unknown template kind "${String(kindParam)}"`)
            res.json(queryFlag(req.query.data) ? await service.listRecords(kindParam) : await service.list(kindParam))
            return
        }
        res.json(queryFlag(req.query.data) ? await service.listRecords() : await service.list())
    }))

    router.get('/:kind', asyncHandler(async (req, res) => {
        const kind = TemplateService.parseKind(req.params.kind)
        res.json(queryFlag(req.query.data) ? await service.listRecords(kind) : await service.list(kind))
    }))

    router.post('/:kind', asyncHandler(async (req, res) => {
        const record = await service.create(TemplateService.parseKind(req.params.kind), req.body)
        res.status(201).location(`/api/templates/${record.kind}/${record.id}`).json(record)
    }))

    router.post('/:kind/validate', asyncHandler(async (req, res) => {
        const issues = await service.validate(TemplateService.parseKind(req.params.kind), req.body)
        res.json({valid: issues.length === 0, issues})
    }))

    router.get('/:kind/:id', asyncHandler(async (req, res) => {
        res.json(await service.get(TemplateService.parseKind(req.params.kind), req.params.id))
    }))

    router.put('/:kind/:id', asyncHandler(async (req, res) => {
        res.json(await service.update(TemplateService.parseKind(req.params.kind), req.params.id, req.body))
    }))

    router.delete('/:kind/:id', asyncHandler(async (req, res) => {
        const usage = await service.delete(TemplateService.parseKind(req.params.kind), req.params.id, {force: queryFlag(req.query.force)})
        res.json({deleted: true, prunedFrom: usage.collections, dangling: usage.templates})
    }))

    router.get('/:kind/:id/usage', asyncHandler(async (req, res) => {
        const kind = TemplateService.parseKind(req.params.kind)
        await service.get(kind, req.params.id)
        res.json(await service.usage({kind, id: req.params.id}))
    }))

    router.get('/:kind/:id/resolved', asyncHandler(async (req, res) => {
        res.json(await service.resolve(TemplateService.parseKind(req.params.kind), req.params.id))
    }))

    return router
}
