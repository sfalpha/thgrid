import {Router} from "express";
import {listTemplateKindDefinitions, toTemplateKindInfo, TemplateKindInfo} from "../../templates/registry";
import {TransmissionVoltage} from "../../models/transmission.voltage";
import {ConductorMountType, TransmissionWireType, TransmissionWireUnit} from "../../models/transmission.conductor";
import {TowerType} from "../../models/transmission.tower";
import {GenerationType} from "../../models/generation";
import {SubstationArrangement} from "../../models/substation";
import {SubstationBusType} from "../../models/substation.bus";
import {BayTemplateType} from "../../models/substation.bay";
import {SubstationEquipmentType} from "../../models/substation.equipment";
import {
    TransformerCooling,
    TransformerWindingSide,
    TransformerWindingTapChanger,
    TransformerWindingWiring,
} from "../../models/transformer";
import {TEMPLATE_ID_PATTERN} from "../../templates/template";
import {WINDING_KEY_PATTERN} from "../../templates/validation";

/** Everything the UI needs to render forms without hard-coding enum values. */
export interface MetaResponse {
    kinds: TemplateKindInfo[]
    enums: {
        transmissionVoltage: string[]
        transmissionWireType: string[]
        transmissionWireUnit: string[]
        conductorMountType: string[]
        towerType: string[]
        transformerWindingSide: string[]
        transformerWindingWiring: string[]
        transformerWindingTapChanger: string[]
        transformerCooling: string[]
        generationType: string[]
        substationArrangement: string[]
        substationBusType: string[]
        substationEquipmentType: string[]
        bayTemplateType: string[]
    }
    patterns: {
        templateId: string
        windingKey: string
    }
    version: string
}

export function buildMeta(version: string): MetaResponse {
    return {
        kinds: listTemplateKindDefinitions().map(toTemplateKindInfo),
        enums: {
            transmissionVoltage: Object.values(TransmissionVoltage),
            transmissionWireType: Object.values(TransmissionWireType),
            transmissionWireUnit: Object.values(TransmissionWireUnit),
            conductorMountType: Object.values(ConductorMountType),
            towerType: Object.values(TowerType),
            transformerWindingSide: Object.values(TransformerWindingSide),
            transformerWindingWiring: Object.values(TransformerWindingWiring),
            transformerWindingTapChanger: Object.values(TransformerWindingTapChanger),
            transformerCooling: Object.values(TransformerCooling),
            generationType: Object.values(GenerationType),
            substationArrangement: Object.values(SubstationArrangement),
            substationBusType: Object.values(SubstationBusType),
            substationEquipmentType: Object.values(SubstationEquipmentType),
            bayTemplateType: Object.values(BayTemplateType),
        },
        patterns: {
            templateId: TEMPLATE_ID_PATTERN.source,
            windingKey: WINDING_KEY_PATTERN.source,
        },
        version,
    }
}

export function metaRouter(version: string): Router {
    const router = Router()
    const meta = buildMeta(version)
    router.get('/', (_req, res) => {
        res.json(meta)
    })
    return router
}
