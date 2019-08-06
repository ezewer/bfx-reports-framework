'use strict'

const _isContainedPosStatus = (positions, status) => {
  return positions.every(pos => (
    !pos ||
    typeof pos !== 'object' ||
    pos.status !== status
  ))
}

module.exports = (
  rService,
  dao
) => async ({
  auth,
  symbol,
  end,
  id
}) => {
  const trades = await dao.findInCollBy(
    '_getTrades',
    {
      auth,
      params: {
        symbol,
        end,
        limit: 2
      }
    }
  )
  const {
    res: positionsAudit
  } = await rService.getPositionsAudit(
    null,
    {
      auth,
      params: {
        id: [id],
        limit: 2,
        notThrowError: true,
        notCheckNextPage: true
      }
    }
  )

  if (
    !Array.isArray(trades) ||
    trades.length === 0 ||
    !Array.isArray(positionsAudit) ||
    positionsAudit.length < 2 ||
    _isContainedPosStatus(positionsAudit, 'CLOSED') ||
    _isContainedPosStatus(positionsAudit, 'ACTIVE')
  ) {
    return {
      closePrice: null,
      sumAmount: null
    }
  }
  if (
    trades.length > 1 &&
    trades[0] &&
    typeof trades[0] === 'object' &&
    trades[1] &&
    typeof trades[1] === 'object' &&
    trades[0].orderID &&
    trades[0].orderID !== trades[1].orderID
  ) {
    const activePosition = positionsAudit.find(pos => (
      pos.status === 'ACTIVE'
    ))

    return {
      closePrice: trades[0].execPrice,
      sumAmount: activePosition.amount
    }
  }

  const _ledgers = await dao.findInCollBy(
    '_getLedgers',
    {
      auth,
      params: { end }
    }
  )
  const ledgers = Array.isArray(_ledgers) ? _ledgers : []

  const regexp = new RegExp(`#${id}.*settlement`, 'gi')
  const closedPosition = ledgers.find(ledger => (
    ledger &&
    typeof ledger === 'object' &&
    regexp.test(ledger.description)
  ))

  const closePrice = (
    closedPosition &&
    typeof closedPosition === 'object' &&
    closedPosition.description &&
    typeof closedPosition.description === 'string'
  )
    ? closedPosition.description
    : null

  return {
    closePrice,
    sumAmount: null
  }
}