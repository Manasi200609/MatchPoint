// Adapter contract shared by the local demo and live Switch implementation.
export class SwitchPort {
  async checkConnection() { throw new Error('Switch adapter not configured'); }
  async sendTask(_task) { throw new Error('Switch adapter not configured'); }
  async receiveMessages(_caseId) { throw new Error('Switch adapter not configured'); }
  async publishEvidence(_evidence) { throw new Error('Switch adapter not configured'); }
  async getInvestigationUpdates(_caseId) { throw new Error('Switch adapter not configured'); }
}
