import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCase } from '../src/reconciliation.js';
const input={invoice:{number:'INV-2026-1048',total:48750,additionalCharge:{amount:3750}},purchaseOrder:{number:'PO-2026-089',total:45000},goodsReceived:{total:42000},evidence:[{id:'po-amendment',name:'Purchase order amendment',status:'Missing'},{id:'additional-charge-receipt',name:'Additional charge receipt',status:'Missing'}]};
test('calculates the expected independent variances deterministically',()=>{const r=reconcileCase(input);assert.equal(r.invoiceToPoVariance,3750);assert.equal(r.receivedShortfall,3000);assert.equal(r.unsupportedCharge,3750);assert.equal(r.totalExposure,3750);assert.equal(r.invoiceToPoPercent,8.33);assert.equal(r.receivedShortfallPercent,6.67)});
test('does not double count charge already inside invoice total',()=>{const r=reconcileCase(input);assert.equal(r.totalExposure,48750-45000);assert.notEqual(r.totalExposure,r.invoiceToPoVariance+r.unsupportedCharge)});
test('reports missing evidence, facts, assumptions and questions separately',()=>{const r=reconcileCase(input);assert.equal(r.findings.filter(x=>x.code.startsWith('MISSING_EVIDENCE')).length,2);assert.ok(r.facts.length);assert.ok(r.assumptions.length);assert.ok(r.unresolvedQuestions.length)});
test('same input yields the same financial calculations',()=>{const a=reconcileCase(input),b=reconcileCase(input);for(const k of ['invoiceToPoVariance','receivedShortfall','unsupportedCharge','totalExposure'])assert.equal(a[k],b[k])});
