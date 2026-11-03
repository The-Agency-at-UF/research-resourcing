import { configuredPilotStore } from '../pilot/dynamodb-store.js';
import { computeMetrics, metricsText } from '../pilot/reports.js';
import { verifyPilotTarget } from '../pilot/runtime.js';

// Operator view of the pilot measures for PILOT_NAMESPACE; reads only.
await verifyPilotTarget();
console.log(`Namespace ${process.env.PILOT_NAMESPACE}`);
console.log(metricsText(computeMetrics(await configuredPilotStore().list('')), new Date().toISOString().slice(0, 10)));
