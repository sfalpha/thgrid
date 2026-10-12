import {JsonFileStore} from "./json.file.store";
import {TemplateCollection} from "../../templates/collection";
import {TemplateRef} from "../../templates/template";

/** Collections under `<dataDir>/collections/`. Thin wrapper to keep call sites typed. */
export class CollectionStore extends JsonFileStore<TemplateCollection> {
    /** Collections containing the given template. */
    async referencing(ref: TemplateRef): Promise<TemplateCollection[]> {
        const all = await this.list()
        return all.filter(c => c.items.some(i => i.kind === ref.kind && i.id === ref.id))
    }
}
