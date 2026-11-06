# MATCHPOINT — narrated app walkthrough

**Target runtime:** 3:45–4:00 · **Narration:** measured, warm, confident; approximately 100 words per minute.  
**Footage requirement:** capture the real running app at `localhost:5173`. Keep screen labels and the DEMO / SIMULATED indicators readable. Do not fabricate agent replies or present this walkthrough as a live Switch session.

## 0:00–0:20 — Operations Desk

**Capture:** actual `/operations` route. Begin on the exception queue, hold long enough to read CASE-001 and the demo-mode indicator.

**Voiceover:**

> Accounts payable exceptions rarely arrive with a complete explanation. MATCHPOINT brings the case, its exposure, and the investigation status into one operations desk. This workspace is running in demo mode; no live Switch connection is configured.

## 0:20–0:48 — Open CASE-001

**Capture:** select CASE-001 and show the actual case header, Apex Industrial Supplies, invoice and PO references, amount under review, and synthetic-data label.

**Voiceover:**

> This is CASE-001, a synthetic demonstration case for Apex Industrial Supplies. Invoice INV-2026-1048 is forty-eight thousand seven hundred fifty dollars. Purchase order PO-2026-089 is forty-five thousand dollars. The recorded goods-received value is forty-two thousand dollars.

## 0:48–1:22 — Reconciliation

**Capture:** actual Financial Reconciliation table and variance explanation. Pause on both amounts and the double-counting callout.

**Voiceover:**

> MATCHPOINT calculates the comparisons deterministically. The invoice exceeds the purchase order by three thousand seven hundred fifty dollars. The received value is three thousand dollars below the purchase order. The additional charge is also three thousand seven hundred fifty dollars, but it is already inside the invoice total. The system counts that exposure once.

## 1:22–1:45 — Evidence Room

**Capture:** actual Evidence Room. Hold on the missing PO amendment and missing additional-charge receipt, with their displayed status and source.

**Voiceover:**

> The evidence register shows what is present and what is missing. This case has no purchase order amendment and no receipt supporting the additional charge. MATCHPOINT does not fill those gaps with assumptions. It keeps missing evidence visible as a reason the invoice needs review.

## 1:45–2:35 — Agent Room

**Capture:** actual Agent Room, including the DEMO / SIMULATED banner and stage cards. If showing an existing completed run, keep the simulated label in frame. Do not imply these are live Switch messages.

**Voiceover:**

> The investigation workflow separates three responsibilities. RECON compares the supplied invoice, purchase order, received value, and evidence. AUDITOR independently checks the amounts and challenges unsupported conclusions. RESOLVER brings those findings together and prepares next steps. Here, those agent outputs are local simulations derived from the case data and reconciliation service. They are not messages from a live Switch room.

## 2:35–3:10 — Resolution Report

**Capture:** actual `/reports/CASE-001` route. Show the executive summary, comparison table, evidence register, agent findings, open questions, and audit timeline.

**Voiceover:**

> The report assembles the case details, the calculations, the missing documents, the investigation findings, and the audit timeline. The recommendation is to hold for supporting evidence and human review. The vendor clarification can request the missing amendment and receipt, and ask about the three-thousand-dollar received-value shortfall.

## 3:10–3:42 — Human Decision

**Capture:** return to the actual case page and open its decision panel. Show the real choices and required-reason field. Do not submit a decision while recording.

**Voiceover:**

> Investigation is not authorization. A human reviewer can approve or reject the recommendation, or request further investigation, and each recorded decision requires a reason. MATCHPOINT does not execute payment. The person reviewing the evidence retains the decision and the financial control.

## 3:42–3:55 — Close

**Capture:** finish on the actual report or case header with the synthetic-data and demo-mode labels still visible.

**Voiceover:**

> MATCHPOINT. Every discrepancy deserves an explanation. Autonomous investigation. Auditable decisions. Human control.

## Pronunciation and audio direction

- Say “Apex Industrial Supplies” as written.
- Read monetary amounts in full; do not rush the variance comparison.
- Keep narration ahead of UI transitions and leave short pauses on the two missing-evidence entries.
- Use quiet, restrained music under speech. Keep the voice clear and consistently louder than the music.
