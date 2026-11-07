const BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
async function request(path, options) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Unable to reach MATCHPOINT.');
  return data;
}
export const api = {
  health: () => request('/health'),
  cases: () => request('/cases'), case: id => request(`/cases/${id}`), evidence: id => request(`/cases/${id}/evidence`),
  createCase: body => request('/cases', { method: 'POST', body: JSON.stringify(body) }),
  activity: id => request(`/cases/${id}/activity`), timeline: id => request(`/cases/${id}/timeline`), report: id => request(`/reports/${id}`),
  reconcile: id => request(`/cases/${id}/reconcile`, { method: 'POST' }),
  startInvestigation: id => request(`/cases/${id}/investigations`, { method: 'POST' }),
  investigations: id => request(`/cases/${id}/investigations`),
  investigation: (id, runId) => request(`/cases/${id}/investigations/${runId}`),
  decision: (id, body) => request(`/cases/${id}/decisions`, { method: 'POST', body: JSON.stringify(body) })
};
