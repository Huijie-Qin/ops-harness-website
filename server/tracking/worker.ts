import { parentPort, workerData } from 'node:worker_threads'
import { TrackingDatabase } from './database.js'
const db = new TrackingDatabase(workerData.directory)
parentPort!.on('message', ({ id, method, args }) => {
  try {
    const value = method === 'ingest' ? db.ingest(args[0], args[1]) : method === 'identity' ? db.identity(args[0], args[1]) : method === 'query' ? db.query(args[0], args[1]) : method === 'maintain' ? db.maintain() : method === 'close' ? db.close() : undefined
    parentPort!.postMessage({ id, value })
    if (method === 'close') parentPort!.close()
  } catch { parentPort!.postMessage({ id, error: 'ANALYTICS_UNAVAILABLE' }) }
})
