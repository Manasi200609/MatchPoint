import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const now = '2026-11-04T09:30:00.000Z';
export const seed = () => ({
  cases: [{ id: 'CASE-001', synthetic: true, vendor: 'Apex Industrial Supplies', status: 'Needs review', exceptionType: 'Price variance', createdAt: '2026-11-04T08:15:00.000Z', updatedAt: now,
    invoice: { number: 'INV-2026-1048', total: 48750, additionalCharge: { label: 'Additional charge', amount: 3750 } },
    purchaseOrder: { number: 'PO-2026-089', total: 45000 }, goodsReceived: { total: 42000 },
    evidence: [
      { id: 'invoice', name: 'Invoice INV-2026-1048', type: 'Vendor invoice', source: 'Synthetic case file', status: 'Verified', extractedValues: 'Total $48,750; additional charge $3,750 included', relatedFinding: 'Invoice-to-PO variance' },
      { id: 'purchase-order', name: 'Purchase order PO-2026-089', type: 'Purchase order', source: 'Synthetic case file', status: 'Verified', extractedValues: 'Total $45,000', relatedFinding: 'Invoice-to-PO variance' },
      { id: 'goods-received-record', name: 'Goods-received record', type: 'Receiving record', source: 'Synthetic case file', status: 'Verified', extractedValues: 'Received value $42,000', relatedFinding: 'Receipt shortfall' },
      { id: 'po-amendment', name: 'Purchase order amendment', type: 'Amendment', source: 'Expected supporting document', status: 'Missing', extractedValues: null, relatedFinding: 'Unsupported additional charge' },
      { id: 'additional-charge-receipt', name: 'Additional charge receipt', type: 'Receipt', source: 'Expected supporting document', status: 'Missing', extractedValues: null, relatedFinding: 'Unsupported additional charge' }
    ], decision: null, reconciliationRuns: 0 }],
  activity: [
    { actor: 'RECON', summary: 'Flagged a $3,750 invoice-to-PO variance; charge is included in invoice total.', timestamp: '2026-11-04T09:24:00.000Z', simulated: true },
    { actor: 'AUDITOR', summary: 'Confirmed the arithmetic and noted the missing amendment and charge receipt.', timestamp: '2026-11-04T09:26:00.000Z', simulated: true },
    { actor: 'RESOLVER', summary: 'Prepared a hold-for-evidence recommendation for human review.', timestamp: now, simulated: true }
  ],
  timeline: [
    { title: 'Case created', detail: 'Synthetic demonstration case loaded into local workspace.', actor: 'System', timestamp: '2026-11-04T08:15:00.000Z', type: 'system', simulated: false },
    { title: 'Documents inspected', detail: 'Invoice, purchase order and goods-received values reviewed; amendment and receipt marked missing.', actor: 'RECON', timestamp: '2026-11-04T09:20:00.000Z', type: 'agent', simulated: true },
    { title: 'Discrepancies calculated', detail: '$3,750 invoice-to-PO variance; $3,000 received-goods shortfall; no double counting.', actor: 'RECON', timestamp: '2026-11-04T09:24:00.000Z', type: 'agent', simulated: true },
    { title: 'Independent verification', detail: 'AUDITOR confirmed calculations and identified no supplied support for the additional charge.', actor: 'AUDITOR', timestamp: '2026-11-04T09:26:00.000Z', type: 'agent', simulated: true },
    { title: 'Resolution prepared', detail: 'Hold for human review pending evidence and clarification.', actor: 'RESOLVER', timestamp: now, type: 'agent', simulated: true }
  ]
});
export class JsonCaseRepository {
  constructor(file = process.env.DATA_FILE || path.resolve(here, '../../data/matchpoint.json')) { this.file = path.resolve(here, '../../', file); }
  async init() { await fs.mkdir(path.dirname(this.file), { recursive: true }); try { await fs.access(this.file); } catch { await this.save(seed()); } }
  async read() { await this.init(); return JSON.parse(await fs.readFile(this.file, 'utf8')); }
  async save(data) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
    try {
      await fs.rename(temp, this.file);
    } catch (error) {
      // OneDrive and Windows scanners can briefly hold the destination open.
      // Retry replacement by copying the complete temp file, then clean up.
      if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(error.code)) throw error;
      await fs.copyFile(temp, this.file);
      await fs.unlink(temp);
    }
  }
  async list() { return (await this.read()).cases; }
  async get(id) { return (await this.read()).cases.find(c => c.id === id) || null; }
  async create(record) { const data = await this.read(); data.cases.push(record); await this.save(data); return record; }
  async update(id, fn) { const data = await this.read(); const i = data.cases.findIndex(c => c.id === id); if (i < 0) return null; data.cases[i] = fn(data.cases[i]); await this.save(data); return data.cases[i]; }
  async getWorkspace() { return this.read(); }
  async addActivity(item) { const data = await this.read(); data.activity.unshift(item); await this.save(data); }
  async addTimeline(item) { const data = await this.read(); data.timeline.push(item); await this.save(data); }
}
