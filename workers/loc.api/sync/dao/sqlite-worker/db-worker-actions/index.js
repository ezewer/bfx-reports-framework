'use strict'

const dbWorkerActions = require(
  'bfx-facs-db-better-sqlite/worker/db-worker-actions'
)

const DB_WORKER_ACTIONS = require('./db-worker-actions.const')

const actionRunInTrans = require('./action-run-in-trans')
const actionUpdateRecordOf = require('./action-update-record-of')

module.exports = (db, args) => {
  const { action, sql, params } = args

  if (action === DB_WORKER_ACTIONS.RUN_IN_TRANS) {
    return actionRunInTrans(db, sql, params)
  }
  if (action === DB_WORKER_ACTIONS.UPDATE_RECORD_OF) {
    return actionUpdateRecordOf(db, sql, params)
  }

  return dbWorkerActions(db, args)
}
