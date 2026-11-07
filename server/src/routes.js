import { Router } from 'express';
import { z } from 'zod';

const createSchema = z.object({
  vendor: z.string().min(1),

  invoice: z.object({
    number: z.string().min(1),
    total: z.number().nonnegative(),
    additionalCharge: z.object({
      label: z.string(),
      amount: z.number().nonnegative()
    }).optional()
  }),

  purchaseOrder: z.object({
    number: z.string().min(1),
    total: z.number().nonnegative()
  }),

  goodsReceived: z.object({
    total: z.number().nonnegative()
  }),

  evidence: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      source: z.string(),
      status: z.enum(['Verified', 'Missing']),
      extractedValues: z.string().nullable().optional(),
      relatedFinding: z.string().optional()
    })
  ).default([]),
  testCaseKey: z.enum(['test-case-2', 'test-case-3']).optional(),
  investigationContext: z.string().max(4000).optional()
});

const decisionSchema = z.object({
  action: z.enum([
    'Approve recommendation',
    'Reject recommendation',
    'Request further investigation'
  ]),
  reason: z.string().trim().min(3).max(2000)
});

function activityModeLabel(service) {
  if (service.mode === 'SWITCH') return 'LIVE SWITCH';
  if (service.mode === 'LIVE') return 'LIVE';
  return 'DEMO / SIMULATED';
}

export function switchReconnectHandler(service) {
  return async (_req, res) => {
    try {
      const status = await service.reconnect();

      return res.json({ status });
    } catch (error) {
      if (error?.code === 'switch_not_configured') {
        return res.status(409).json({
          error: 'Live Switch collaboration is not configured.'
        });
      }

      if (error?.code === 'stopping') {
        return res.status(503).json({
          error: 'Switch collaboration is shutting down.'
        });
      }

      // Status retrieval is best-effort. It must not cause the handler
      // to fail again if the underlying integration is unavailable.
      let status = null;

      try {
        status = await service.integrationStatus();
      } catch {
        // Keep the response generic and safe.
      }

      return res.status(503).json({
        error: 'Switch reconnection failed.',
        status
      });
    }
  };
}

export function makeRouter(service, repo) {
  const router = Router();

  router.post(
    '/switch/reconnect',
    switchReconnectHandler(service)
  );

  router.get('/cases', async (_req, res, next) => {
    try {
      res.json(await service.listCases());
    } catch (error) {
      next(error);
    }
  });

  router.post('/cases', async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid case data',
          details: parsed.error.flatten()
        });
      }

      const createdCase = await service.createCase(parsed.data);

      res.status(201).json({
        case: createdCase
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/cases/:id', async (req, res, next) => {
    try {
      const result = await service.getCase(req.params.id);

      if (!result) {
        return res.status(404).json({
          error: 'Case not found'
        });
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/cases/:id/investigations', async (req, res, next) => {
    try {
      const investigations = await service.listInvestigations(
        req.params.id
      );

      if (!investigations) {
        return res.status(404).json({
          error: 'Case not found'
        });
      }

      res.json({
        investigations,
        mode: service.mode
      });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/cases/:id/investigations/:investigationId',
    async (req, res, next) => {
      try {
        const investigation = await service.getInvestigation(
          req.params.id,
          req.params.investigationId
        );

        if (!investigation) {
          return res.status(404).json({
            error: 'Investigation not found'
          });
        }

        res.json({ investigation });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post('/cases/:id/investigations', async (req, res, next) => {
    try {
      const run = await service.startInvestigation(req.params.id);

      if (!run) {
        return res.status(404).json({
          error: 'Case not found'
        });
      }

      res.status(202).json({
        investigation: run
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/cases/:id/reconcile', async (req, res, next) => {
    try {
      const result = await service.runReconciliation(req.params.id);

      if (!result) {
        return res.status(404).json({
          error: 'Case not found'
        });
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/cases/:id/evidence', async (req, res, next) => {
    try {
      const caseData = await repo.get(req.params.id);

      if (!caseData) {
        return res.status(404).json({
          error: 'Case not found'
        });
      }

      res.json({
        evidence: caseData.evidence
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/cases/:id/activity', async (req, res, next) => {
    try {
      const caseData = await repo.get(req.params.id);

      if (!caseData) {
        return res.status(404).json({
          error: 'Case not found'
        });
      }

      const db = await repo.getWorkspace();

      res.json({
        activity: db.activity,
        mode: activityModeLabel(service)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/cases/:id/timeline', async (req, res, next) => {
    try {
      const caseData = await repo.get(req.params.id);

      if (!caseData) {
        return res.status(404).json({
          error: 'Case not found'
        });
      }

      const db = await repo.getWorkspace();

      res.json({
        timeline: db.timeline
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/reports/:id', async (req, res, next) => {
    try {
      const result = await service.getReport(req.params.id);

      if (!result) {
        return res.status(404).json({
          error: 'Case not found'
        });
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/cases/:id/decisions', async (req, res, next) => {
    try {
      const parsed = decisionSchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          error: 'A valid decision and reason are required',
          details: parsed.error.flatten()
        });
      }

      const updatedCase = await service.decide(
        req.params.id,
        parsed.data
      );

      if (!updatedCase) {
        return res.status(404).json({
          error: 'Case not found'
        });
      }

      res.json({
        case: updatedCase
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
