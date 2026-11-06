// Local demo adapter. It never claims to connect to Switch.
export class MockSwitchAdapter {
  mode = 'SIMULATED';
  constructor(seed = []) { this.messages = [...seed]; }
  async checkConnection() { return { connected: true, mode: 'SIMULATED', label: 'DEMO / SIMULATED' }; }
  async sendTask({ caseId, agent, task }) { const message = { id: `demo-${Date.now()}`, caseId, agent, task, simulated: true, timestamp: new Date().toISOString() }; this.messages.push(message); return message; }
  async receiveMessages(caseId) { return this.messages.filter(x => x.caseId === caseId); }
  async publishEvidence({ caseId, evidence }) { return { caseId, evidence, simulated: true, timestamp: new Date().toISOString() }; }
  async getInvestigationUpdates(caseId) { return this.messages.filter(x => x.caseId === caseId); }
}
