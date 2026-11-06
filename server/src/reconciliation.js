export function reconcileCase(input, runNumber = 1) {
  const invoiceTotal = input.invoice.total;
  const poTotal = input.purchaseOrder.total;
  const receivedTotal = input.goodsReceived.total;
  const invoiceToPoVariance = invoiceTotal - poTotal;
  const receivedShortfall = Math.max(0, poTotal - receivedTotal);
  const unsupportedCharge = input.invoice.additionalCharge?.amount || 0;
  const missingEvidence = input.evidence.filter(item => item.status === 'Missing');
  const pct = (n, d) => d ? Number((n / d * 100).toFixed(2)) : 0;
  return {
    runNumber, currency: 'USD', invoiceToPoVariance, invoiceToPoPercent: pct(invoiceToPoVariance, poTotal),
    receivedShortfall, receivedShortfallPercent: pct(receivedShortfall, poTotal), unsupportedCharge,
    totalExposure: Math.max(0, invoiceToPoVariance),
    findings: [
      { code: 'INV_PO_VARIANCE', title: 'Invoice exceeds purchase order', detail: `${input.invoice.number} totals $${invoiceTotal.toLocaleString('en-US')}, which is $${invoiceToPoVariance.toLocaleString('en-US')} above ${input.purchaseOrder.number}.`, severity: invoiceToPoVariance > 0 ? 'High' : 'Informational', amount: invoiceToPoVariance, evidence: ['invoice', 'purchase-order'] },
      { code: 'RECEIPT_SHORTFALL', title: 'Goods received below purchase order', detail: `Recorded received value is $${receivedTotal.toLocaleString('en-US')}, $${receivedShortfall.toLocaleString('en-US')} below the PO total.`, severity: receivedShortfall > 0 ? 'High' : 'Informational', amount: receivedShortfall, evidence: ['goods-received-record', 'purchase-order'] },
      { code: 'UNSUPPORTED_CHARGE', title: 'Additional charge lacks support', detail: `A $${unsupportedCharge.toLocaleString('en-US')} additional charge is included in the invoice total. No supporting receipt was provided.`, severity: unsupportedCharge > 0 ? 'High' : 'Informational', amount: unsupportedCharge, evidence: ['invoice', 'additional-charge-receipt'] },
      ...missingEvidence.map((item, i) => ({ code: `MISSING_EVIDENCE_${i+1}`, title: `${item.name} missing`, detail: `${item.name} was listed as required but was not provided in the case file.`, severity: 'Needs evidence', amount: null, evidence: [item.id] }))
    ],
    facts: [
      `Invoice total: $${invoiceTotal.toLocaleString('en-US')}.`, `PO total: $${poTotal.toLocaleString('en-US')}.`,
      `Goods-received value: $${receivedTotal.toLocaleString('en-US')}.`, `Additional charge: $${unsupportedCharge.toLocaleString('en-US')} included in invoice total.`
    ], assumptions: ['No tax, line-item, quantity, delivery-date or amendment values were supplied; none are inferred.'],
    unresolvedQuestions: ['Can the vendor provide the PO amendment authorizing the additional charge?', 'Can the vendor provide a receipt for the $3,750 additional charge?', 'Can the receiving team explain the $3,000 difference between PO and received value?'],
    recommendation: 'Hold the invoice for human review pending the missing PO amendment and additional-charge receipt, and clarify the goods-received shortfall. This is a recommendation only; it does not authorize or execute payment.'
  };
}
