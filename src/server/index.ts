import {loadConfig} from "./config";
import {createApp, createContext} from "./app";

async function main() {
    const config = loadConfig()
    const ctx = await createContext(config)
    const app = createApp(ctx)
    app.listen(config.port, config.host, () => {
        console.log(`thgrid backend listening on http://${config.host}:${config.port}`)
        console.log(`data directory: ${config.dataDir}`)
    })
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
