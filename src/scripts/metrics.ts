import { configuredStore } from '../resourcing/dynamodb-store.js';
import { computeMetrics, metricsText } from '../resourcing/reports.js';
import { verifyAwsTarget } from '../resourcing/runtime.js';

// Operator view of the success measures for RESOURCING_NAMESPACE; reads only.
await verifyAwsTarget();
console.log(`Namespace ${process.env.RESOURCING_NAMESPACE}`);
console.log(metricsText(computeMetrics(await configuredStore().list('')), new Date().toISOString().slice(0, 10)));
