import {PowerTransformerTemplate} from "../templates/power.transformer";
import {SubstationBay} from "../models/substation.bay";
import {
    TransformerWinding,
    TransformerWindingProps
} from "../models/substation.transformer.winding";
import {SubstationPowerTransformer} from "../models/substation.power.transformer";

interface SubstationPowerTransformerMeta {
    bay: SubstationBay
    code: string
}

export class SubstationPowerTransformerFactory {
    public static new(template: PowerTransformerTemplate, meta: SubstationPowerTransformerMeta): SubstationPowerTransformer {
        const transformer = new SubstationPowerTransformer(
            {
                code: meta.code,
                bay: meta.bay
            }
        )
        for (const w in template.windings) {
            const ww: TransformerWindingProps = {
                transformer: transformer,
                tapChanger: template.windings[w].tapChanger,
                windingSide: template.windings[w].windingSide,
                wiring: template.windings[w].wiring,
                ratings: template.windings[w]?.ratings
            }
            transformer.windings[w] = new TransformerWinding(ww)
            transformer.modules = template?.modules || 1
        }
        return transformer
    }
}