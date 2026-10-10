import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type {
  Authentication,
  Identity,
} from "../../../../packages/security/src/auth.js";
import type { ChatService } from "../../../../packages/chat/src/service.js";
import { AppError } from "../../../../packages/shared/src/errors.js";
export function chatRouter(chat: ChatService, auth: Authentication) {
  // Mounted inside ingestionRouter, after verified identity, origin and JSON limits.
  const router = Router();
  const identity = (res: { locals: Record<string, unknown> }) =>
    res.locals.identity as Identity;
  const scope = z
    .object({
      policyId: z.uuid(),
      comparisonPolicyId: z.uuid().optional(),
      asOfDate: z.iso.date(),
      versionIds: z.array(z.uuid()).min(1).max(20).optional(),
    })
    .strict();
  router.get("/conversations", async (_req, res) =>
    res.json({ items: await chat.list(identity(res)) }),
  );
  router.post("/conversations", async (req, res) =>
    res
      .status(201)
      .json(
        await chat.create(
          identity(res),
          scope.parse(req.body),
          String(res.getHeader("X-Request-Id")),
        ),
      ),
  );
  router.get("/conversations/:id", async (req, res) =>
    res.json(await chat.detail(identity(res), z.uuid().parse(req.params.id))),
  );
  let active = 0;
  router.post(
    "/conversations/:id/messages",
    rateLimit({
      windowMs: 60000,
      limit: 10,
      keyGenerator: (_req, res) => identity(res).id,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({ error: { code: "CHAT_RATE_LIMITED" } }),
    }),
    async (req, res) => {
      const id = z.uuid().parse(req.params.id),
        key = z.uuid().parse(req.header("Idempotency-Key"));
      const { question } = z
        .object({ question: z.string().trim().min(1).max(4000) })
        .strict()
        .parse(req.body);
      if (active >= 2) throw new AppError("CHAT_CAPACITY_REACHED", 429);
      // Fail authorization before opening an SSE stream or running a model.
      await chat.detail(identity(res), id);
      if (active >= 2) throw new AppError("CHAT_CAPACITY_REACHED", 429);
      active++;
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(240000),
      ]);
      const stream = req.get("Accept")?.includes("text/event-stream") ?? false;
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      const event = (type: string, data: unknown) => {
        if (stream && !res.destroyed && !signal.aborted)
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      if (stream) {
        res.status(200).set({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
          Connection: "keep-alive",
        });
        res.flushHeaders();
        event("status", { stage: "accepted" });
      }
      const heartbeat = stream
        ? setInterval(() => event("heartbeat", {}), 10000)
        : undefined;
      try {
        const answer = await chat.answer(
          identity(res),
          id,
          question,
          key,
          String(res.getHeader("X-Request-Id")),
          signal,
          (stage) => event("status", { stage }),
          async () => {
            const current = await auth.authenticate(req);
            const previous = identity(res);
            if (
              current.id !== previous.id ||
              current.tenantId !== previous.tenantId ||
              current.role !== previous.role
            )
              throw new AppError("ACCESS_CHANGED", 403);
          },
        );
        if (res.destroyed) return;
        if (stream) {
          // Provider output is buffered until citation validation and atomic persistence succeed.
          // Stream complete validated paragraphs, never raw untrusted model tokens.
          for (const part of answer.answer.match(/[^\n]+\n*|\n+/g) ?? [])
            event("delta", { text: part });
          event("done", answer);
          res.end();
        } else res.json(answer);
      } catch (error) {
        const code = error instanceof AppError ? error.code : "CHAT_FAILED";
        if (!res.destroyed) {
          if (stream) {
            event("error", { code, requestId: res.getHeader("X-Request-Id") });
            res.end();
          } else
            res.status(error instanceof AppError ? error.status : 503).json({
              error: { code, requestId: res.getHeader("X-Request-Id") },
            });
        }
      } finally {
        clearInterval(heartbeat);
        active--;
      }
    },
  );
  return router;
}
