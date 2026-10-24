/**
 * Runs the editor tests (docs/testing.md): `npm test`, or `npm test -- LC-O` for the cases whose id starts with that.
 */
import {runTests} from './harness'
import './lineCreation.test'
import './busyPlaces.test'
import './naming.test'
import './operations.test'
import './drafts.test'
import './siteSize.test'
import './sectionalize.test'
import './extract.test'
import './disconnect.test'
import './templateOrder.test'

const failed = runTests(process.argv[2])
process.exitCode = failed ? 1 : 0
