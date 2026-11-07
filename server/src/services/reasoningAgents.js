import { GroqProvider } from './GroqProvider.js';
import { parseAgentJson } from './agentWorkflow.js';

const instructions = {
  RECON: 'You are RECON, the invoice investigator. Use only supplied source records. Compare invoice, PO and received values, calculate dollar and percentage variances, identify missing evidence and possible duplicates. Separate confirmed facts from assumptions. Never treat an unsupported charge as legitimate or invent a document. Do not double count an invoice line already included in the total.',
  AUDITOR: 'You are AUDITOR, an independent verifier. Re-read the original source records and independently calculate invoice total minus PO total, PO total minus goods-received total, and any unsupported charge from the invoice/charge source records. Do not copy RECON or supplied calculations as your own arithmetic. Check whether the additional charge is already included in the invoice total and never double count it. Compare your calculations with RECON, explicitly agree or disagree with each material conclusion, cite source evidence, and state unresolved gaps. Return exactly these top-level keys with these types: agent (string, exactly AUDITOR), task_id (string, copied exactly from the input), case_id (string, copied exactly from the input), status (exactly complete or needs_review), findings (array), evidence (array), calculations (array), unresolved_questions (array), recommendation (string), reasoning_summary (string). Do not use other status words such as reviewed, verified, or challenged. Include at least one finding describing the independent calculation or its result. Do not omit fields or replace arrays with strings/objects.',
  RESOLVER: 'You are RESOLVER, the resolution specialist. Review original data, RECON and AUDITOR. Resolve disagreements only where evidence permits, list unresolved issues, specify vendor evidence needed and draft a professional vendor clarification. Never authorize payment or claim human approval.'
};

const commonKeys = ['agent', 'task_id', 'case_id', 'status', 'findings', 'evidence', 'calculations', 'unresolved_questions', 'recommendation', 'reasoning_summary'];
export function validateReasoningOutput(role, raw, { taskId, caseId } = {}) {
  const value = parseAgentJson(raw, role);
  for (const key of commonKeys) if (!(key in value)) throw new Error(`${role} response is missing ${key}.`);
  if (value.agent !== role || value.task_id !== taskId || value.case_id !== caseId) throw new Error(`${role} response correlation fields do not match the requested task (agent=${String(value.agent)}, task_id=${String(value.task_id)}, case_id=${String(value.case_id)}).`);
  if (!['complete', 'needs_review'].includes(value.status)) throw new Error(`${role} response status must be "complete" or "needs_review".`);
  for (const key of ['findings', 'evidence', 'calculations', 'unresolved_questions']) if (!Array.isArray(value[key])) throw new Error(`${role} response field ${key} must be an array.`);
  for (const key of ['recommendation', 'reasoning_summary']) if (typeof value[key] !== 'string') throw new Error(`${role} response field ${key} must be a string.`);
  if (role === 'AUDITOR' && value.findings.length === 0) throw new Error('AUDITOR response must include at least one finding.');
  if (role === 'RESOLVER' && (value.payment_authorized !== false || value.human_approval_required !== true)) throw new Error('RESOLVER must require human approval and must not authorize payment.');
  return value;
}

export class ReasoningAgents {
  constructor({ provider = new GroqProvider() } = {}) { this.provider = provider; }

  async run(role, { taskId, caseRecord, recon, auditor }) {
    if (!instructions[role]) throw new Error(`Unknown reasoning agent: ${role}`);
    const source = { task_id: taskId, case_id: caseRecord.id, case: caseRecord, ...(recon ? { recon } : {}), ...(auditor ? { auditor } : {}) };
    const system = `${instructions[role]} Return exactly one JSON object. Required top-level keys: agent, task_id, case_id, status, findings, evidence, calculations, unresolved_questions, recommendation, reasoning_summary. Copy agent, task_id, and case_id exactly from the input. status must be exactly complete or needs_review. findings/evidence/calculations/unresolved_questions must be arrays; recommendation and reasoning_summary must be strings. Do not omit fields or use alternate status words. Keep reasoning_summary concise and do not provide hidden chain-of-thought. For RESOLVER also include human_approval_required:true and payment_authorized:false.`;
    const user = JSON.stringify(source);
    const raw = await this.provider.complete({ system, user });
    try {
      return validateReasoningOutput(role, raw, { taskId, caseId: caseRecord.id });
    } catch (error) {
      // A reasoning response with sound content but incorrect correlation
      // metadata can be recovered with one explicit correction request.
      // All other validation failures still fail closed.
      if (!/correlation fields do not match/.test(error.message)) throw error;
      const corrected = await this.provider.complete({
        system: `${system}\nThe required correlation values are exact: agent=${role}; task_id=${taskId}; case_id=${caseRecord.id}. Copy each value exactly.`,
        user
      });
      return validateReasoningOutput(role, corrected, { taskId, caseId: caseRecord.id });
    }
  }
}

export const roleInstructions = instructions;
