import { reconcileCase } from '../reconciliation.js';

export function parseAgentJson(raw, role) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${role} response was not valid JSON.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${role} response must be a JSON object.`);
  return value;
}

const isNumber = n => typeof n === 'number' && Number.isFinite(n);
function validateRecon(x) {
  for (const key of ['invoiceAmount','poAmount','goodsReceivedAmount','invoiceToPoVariance','poToReceiptVariance','unsupportedCharges','totalExposure']) if (!isNumber(x[key])) throw new Error(`RECON response is missing numeric field ${key}.`);
  if (!Array.isArray(x.missingEvidence) || !Array.isArray(x.findings) || x.findings.some(f => !f || typeof f.title !== 'string' || !Array.isArray(f.evidence)) || typeof x.preliminaryRecommendation !== 'string') throw new Error('RECON response is missing required findings or source citations.');
  return x;
}
function validateAuditor(x) {
  for (const key of ['verifiedFindings','disputedFindings','calculationChecks','evidenceGaps']) if (!Array.isArray(x[key])) throw new Error(`AUDITOR response is missing ${key}.`);
  if (typeof x.auditConclusion !== 'string') throw new Error('AUDITOR response is missing auditConclusion.');
  return x;
}
function validateResolver(x) {
  if (typeof x.executiveRecommendation !== 'string' || typeof x.reason !== 'string' || !Array.isArray(x.supportingFindings) || !Array.isArray(x.outstandingEvidence) || !Array.isArray(x.requiredNextActions) || typeof x.suggestedVendorClarification !== 'string' || x.humanApprovalRequired !== true || x.paymentAuthorized !== false) throw new Error('RESOLVER response is missing required resolution fields or human approval gate.');
  return x;
}

export function auditRecon(caseRecord, recon, calculations = reconcileCase(caseRecord)) {
  const expected = { invoiceAmount: caseRecord.invoice.total, poAmount: caseRecord.purchaseOrder.total, goodsReceivedAmount: caseRecord.goodsReceived.total, invoiceToPoVariance: calculations.invoiceToPoVariance, poToReceiptVariance: calculations.receivedShortfall, unsupportedCharges: calculations.unsupportedCharge };
  const checks = Object.entries(expected).map(([key, value]) => ({ field: key, expected: value, reported: recon[key], passed: recon[key] === value }));
  const disputedFindings = checks.filter(x => !x.passed).map(x => `RECON reported ${x.field} as ${x.reported}; deterministic source values calculate ${x.expected}.`);
  const missingEvidence = caseRecord.evidence.filter(e => e.status === 'Missing').map(e => e.name);
  const reportedMissing = new Set((recon.missingEvidence || []).map(x => typeof x === 'string' ? x : x.name));
  for (const doc of missingEvidence) if (![...reportedMissing].some(x => String(x).toLowerCase() === doc.toLowerCase())) disputedFindings.push(`RECON omitted missing evidence: ${doc}.`);
  const doubleCounted = recon.totalExposure != null && recon.totalExposure !== calculations.totalExposure;
  if (doubleCounted) disputedFindings.push(`RECON total exposure (${recon.totalExposure}) does not match invoice-to-PO exposure (${calculations.totalExposure}); the included charge must not be counted twice.`);
  return {
    verifiedFindings: checks.filter(x => x.passed).map(x => `${x.field} verified at ${x.expected}.`), disputedFindings,
    calculationChecks: checks, evidenceGaps: missingEvidence,
    auditConclusion: disputedFindings.length ? 'RECON requires correction or qualification before resolution.' : 'RECON arithmetic and evidence references independently verified against source case data.',
    verificationStatus: disputedFindings.length ? 'CHALLENGED' : 'VERIFIED'
  };
}

export function resolveFindings(caseRecord, recon, auditor, calculations = reconcileCase(caseRecord)) {
  const disagreements = auditor.disputedFindings || [];
  const recommendation = calculations.unsupportedCharge > 0 || calculations.findings.some(f => f.code.startsWith('MISSING_EVIDENCE')) || calculations.receivedShortfall > 0
    ? 'HOLD FOR SUPPORTING EVIDENCE AND HUMAN REVIEW'
    : 'Proceed to human review';
  return {
    executiveRecommendation: recommendation,
    reason: `${calculations.invoiceToPoVariance} invoice-to-PO variance; ${calculations.receivedShortfall} PO-to-receipt shortfall; ${calculations.unsupportedCharge} unsupported additional charge already included in the invoice total. ${disagreements.length ? `${disagreements.length} AUDITOR challenge(s) remain unresolved.` : 'AUDITOR verified the reported arithmetic.'}`,
    supportingFindings: calculations.findings.map(f => ({ code: f.code, title: f.title, amount: f.amount, evidence: f.evidence })),
    outstandingEvidence: caseRecord.evidence.filter(e => e.status === 'Missing').map(e => e.name),
    requiredNextActions: ['Request the purchase order amendment', 'Request the additional-charge receipt', 'Clarify the goods-received shortfall', 'Obtain human review and record a reasoned decision'],
    suggestedVendorClarification: 'Please provide the purchase order amendment authorizing the additional charge and its supporting receipt. Please also clarify the $3,000 difference between the purchase order total and the recorded goods-received value.',
    unresolvedDisagreements: disagreements,
    humanApprovalRequired: true,
    paymentAuthorized: false
  };
}

export function buildMockWorkflow(caseRecord) {
  const calculations = reconcileCase(caseRecord);
  const missingEvidence = caseRecord.evidence.filter(e => e.status === 'Missing').map(e => e.name);
  const recon = {
    invoiceAmount: caseRecord.invoice.total, poAmount: caseRecord.purchaseOrder.total, goodsReceivedAmount: caseRecord.goodsReceived.total,
    invoiceToPoVariance: calculations.invoiceToPoVariance, poToReceiptVariance: calculations.receivedShortfall,
    unsupportedCharges: calculations.unsupportedCharge, totalExposure: calculations.totalExposure,
    missingEvidence, findings: calculations.findings, preliminaryRecommendation: calculations.recommendation,
    sourceFacts: calculations.facts, assumptions: calculations.assumptions
  };
  const auditor = auditRecon(caseRecord, recon, calculations);
  const resolver = resolveFindings(caseRecord, recon, auditor, calculations);
  return { calculations, recon, auditor, resolver };
}

export function buildAgentPrompt(role, caseRecord, { calculations, recon, auditor }) {
  const common = { caseId: caseRecord.id, syntheticDemo: Boolean(caseRecord.synthetic), invoice: caseRecord.invoice, purchaseOrder: caseRecord.purchaseOrder, goodsReceived: caseRecord.goodsReceived, evidence: caseRecord.evidence };
  const replyRule = 'Reply as a message in this same Switch thread, with only the requested JSON object in the message body. Do not start a new room message.';
  if (role === 'RECON') return `You are RECON, the accounts-payable investigation agent. Investigate only the supplied case record. Calculate and explain every amount from source values; do not invent data. The deterministic backend calculation is provided for cross-checking; report any mismatch honestly. Return only one JSON object with numeric invoiceAmount, poAmount, goodsReceivedAmount, invoiceToPoVariance, poToReceiptVariance, unsupportedCharges and totalExposure; arrays missingEvidence and findings; preliminaryRecommendation string. Each finding needs title, detail and evidence (source IDs). The additional charge is included in invoice total; do not double count. ${replyRule} Case JSON: ${JSON.stringify(common)}. Deterministic calculation JSON: ${JSON.stringify(calculations)}`;
  if (role === 'AUDITOR') return `You are AUDITOR. Independently challenge RECON; do not accept its claims without recalculating against source data. Check no double count, cite gaps, distinguish verified and disputed items. Return only one JSON object with arrays verifiedFindings, disputedFindings, calculationChecks, evidenceGaps; strings auditConclusion and verificationStatus. ${replyRule} Case JSON: ${JSON.stringify(common)}. RECON output: ${JSON.stringify(recon)}. Independent deterministic calculation: ${JSON.stringify(calculations)}`;
  return `You are RESOLVER. Synthesize original case data, RECON, and AUDITOR. Resolve disagreements only when evidence supports it. Recommend operational next steps and draft vendor clarification. Never approve or execute payment. Return only one JSON object with strings executiveRecommendation, reason, suggestedVendorClarification; arrays supportingFindings, outstandingEvidence, requiredNextActions, unresolvedDisagreements; boolean humanApprovalRequired:true; paymentAuthorized:false. ${replyRule} Case JSON: ${JSON.stringify(common)}. RECON: ${JSON.stringify(recon)}. AUDITOR: ${JSON.stringify(auditor)}. Backend reconciliation: ${JSON.stringify(calculations)}`;
}

export function validateRoleOutput(role, raw) {
  const parsed = parseAgentJson(raw, role);
  if (role === 'RECON') return validateRecon(parsed);
  if (role === 'AUDITOR') return validateAuditor(parsed);
  return validateResolver(parsed);
}
