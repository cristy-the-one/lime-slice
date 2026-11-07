/**
 * Background jobs and plans: a call that runs past the reply time becomes a job, and plan_run runs steps through the same pipeline.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { ProtocolError } from "../engine.ts";
import { imagesOf, withImages, type InlineImage } from "../inline.ts";
import { planProblem, resolveReferences, type PlanStep } from "../plan.ts";
import { validateTool } from "../schema.ts";
import { isComposite } from "../../src/modeling/compose.ts";
import { CHANGES_NOTHING, type CallMeta, SLICE_WAIT_DEFAULT_S, SLICE_WAIT_MAX_S, WHILE_BUSY, type WorkJob, replySeconds } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

/** The call's answer, or a job handle when it is not done within replySeconds() or its request is cancelled. */
function detachable(this: Session, name: string, input: Record<string, unknown>, work: Promise<Record<string, unknown>>, ctx: CallMeta, stop: AbortController, request?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const finish = () => {
      answered = true;
      clearTimeout(timer);
      request?.removeEventListener("abort", detach);
    };
    const detach = () => {
      if (answered) return;
      finish();
      resolve(this.workReply(this.startWorkJob(name, input, work, ctx, stop)));
    };
    const timer = setTimeout(detach, replySeconds() * 1000);
    timer.unref?.();
    request?.addEventListener("abort", detach, { once: true });
    work.then((value) => {
      if (answered) return;
      finish();
      resolve(value);
    }, (err: unknown) => {
      if (answered) return;
      finish();
      reject(err);
    });
    if (request?.aborted) detach();
  });
}

function startWorkJob(this: Session, name: string, input: Record<string, unknown>, work: Promise<Record<string, unknown>>, ctx: CallMeta, stop: AbortController): WorkJob {
  if (!ctx.planJob) this.jobSeq += 1;
  const object = typeof input.object === "string" ? input.object : name.startsWith("model_") || name === "solid_new" ? this.selected : undefined;
  const stoppable = name === "plan_run" || name === "recipe_run" || name === "model_apply_batch" || name === "model_build" || (name === "model_apply" && isComposite((input.op as { kind?: unknown } | undefined)?.kind));
  const job: WorkJob = { handle: ctx.planJob ?? `job_${this.jobSeq}`, tool: name, ...(object ? { object } : {}), started: Date.now(), ctx, stop, stoppable, done: false, settled: Promise.resolve() };
  job.settled = work.then((value) => {
    job.result = value;
  }, (err: unknown) => {
    job.error = err instanceof Error ? err.message : "The call failed.";
  }).finally(() => {
    job.done = true;
    // The work's own end already scheduled the autosave; a finished job is kept a while for its wait.
    const finished = this.workJobs.filter((row) => row.done);
    if (finished.length > 8) this.workJobs.splice(this.workJobs.indexOf(finished[0]!), 1);
  });
  this.workJobs.push(job);
  return job;
}

/** A job's state as slice_wait and the detached call answer it. A finished job answers with its call's own result. */
function workReply(this: Session, job: WorkJob): Record<string, unknown> {
  if (job.done) {
    if (job.error !== undefined) return refuse("job-failed", job.error, { job: job.handle, status: "error", tool: job.tool });
    const result = job.result ?? { ok: false, code: "job-failed" };
    // A call whose result is a job of its own (slice_start's slice) keeps that handle and status, so the same wait
    // loop goes on to wait for the slice; the background job is named beside it.
    if (typeof result.job === "string") return { ...result, workJob: job.handle, tool: job.tool };
    return { ...result, job: job.handle, status: "done", tool: job.tool };
  }
  return {
    ok: true,
    job: job.handle,
    status: "running",
    tool: job.tool,
    ...(job.object ? { object: job.object } : {}),
    fraction: Math.round((job.ctx.fraction ?? 0) * 1000) / 1000,
    ...(job.ctx.stage ? { stage: job.ctx.stage } : {}),
    seconds: Math.round((Date.now() - job.started) / 1000),
    note: `${job.tool} runs longer than a client waits, so it goes on in the background. Call slice_wait {job:"${job.handle}"} until status is done: that reply is the call's own result. slice_cancel takes the work back. Edits wait until it is done.`,
  };
}

/** While a background job runs, only reads that leave the modeler alone, and the job's wait and cancel, are answered. */
function busyRefusal(this: Session, name: string): Record<string, unknown> | null {
  const job = this.workJobs.find((row) => !row.done);
  if (!job || WHILE_BUSY.has(name)) return null;
  const at = job.ctx.stage ? `, ${job.ctx.stage}` : "";
  return refuse("job-running", `${job.tool}${job.object ? ` on ${job.object}` : ""} is still running in the background as ${job.handle}${at}. Call slice_wait {job:"${job.handle}"} until it is done, or slice_cancel to take it back, then call this again.`, { job: job.handle }, NEXT.slicewait);
}

/**
 * plan_run: its steps in order through runCall, so each is checked, applied, and autosaved as if called alone. The
 * plan as a whole is detachable: past replySeconds() it answers with a job, and slice_wait returns the plan's result.
 */
function planRun(this: Session, args: unknown, meta?: CallMeta): Promise<Record<string, unknown>> {
  const problem = validateTool("plan_run", args ?? {});
  if (problem) throw new ProtocolError(problem);
  const steps = (args as { steps: PlanStep[] }).steps;
  const bad = planProblem(steps);
  if (bad) throw new ProtocolError(bad);
  if (this.inflight === 0) this.flushAutosave();
  const stop = new AbortController();
  const ctx: CallMeta = { progressToken: meta?.progressToken, signal: stop.signal, planJob: `job_${++this.jobSeq}` };
  const work = this.callContext.run(ctx, () => this.runPlan(steps, ctx));
  return this.detachable("plan_run", args as Record<string, unknown>, work, ctx, stop, meta?.signal);
}

async function runPlan(this: Session, steps: PlanStep[], ctx: CallMeta): Promise<Record<string, unknown>> {
  const results: Record<string, unknown>[] = [];
  const done: Record<string, unknown>[] = [];
  const images: InlineImage[] = [];
  const end = (head: Record<string, unknown>) => withImages({ ...head, steps: done }, images);
  for (let i = 0; i < steps.length; i += 1) {
    const n = i + 1;
    const tool = steps[i]!.tool;
    if (ctx.signal?.aborted) return end(refuse("plan-cancelled", `The plan was cancelled before step ${n} (${tool}). The steps before it stay applied.`, { failedStep: n }));
    const resolved = resolveReferences(steps[i]!.args ?? {}, results, n);
    if ("reason" in resolved) return end(refuse("plan-reference", resolved.reason, { failedStep: n }));
    this.noteStage(`plan step ${n} of ${steps.length}: ${tool}`, i / steps.length);
    let value: Record<string, unknown>;
    try {
      value = await this.runCall(tool, resolved.value, ctx, true);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "The step failed.";
      done.push({ step: n, tool, ok: false, code: "plan-step-failed", reason });
      return end(refuse("plan-step-failed", `Step ${n} (${tool}) failed: ${reason}`, { failedStep: n }));
    }
    images.push(...imagesOf(value));
    results.push(value);
    done.push({ step: n, tool, result: value });
    // A plan can run for minutes. Persist the plate at the completed step boundary, before starting another step;
    // the ordinary delayed autosave waits for the whole plan's inflight call and would otherwise lose every step.
    const completed = done.filter((row) => (row.result as Record<string, unknown> | undefined)?.ok !== false).map((row) => ({ step: Number(row.step), tool: String(row.tool) }));
    this.flushAutosave({ job: ctx.planJob!, total: steps.length, completed });
    await this.autosaveSettled();
    if (value.ok === false) return end(refuse("plan-step-failed", `Step ${n} (${tool}) was refused: ${typeof value.reason === "string" ? value.reason : "no reason given."}`, { failedStep: n }));
  }
  return end({ ok: true });
}

/** What the call is doing now, for its progress notifications and its job's wait. */
function noteStage(this: Session, stage: string, fraction?: number): void {
  const meta = this.callContext.getStore();
  if (!meta) return;
  meta.stage = stage;
  if (fraction !== undefined) meta.fraction = fraction;
  this.onProgress?.("model", meta.fraction ?? 0, stage, meta.progressToken);
}

async function workWait(this: Session, job: WorkJob, meta: CallMeta | undefined, timeoutS?: number): Promise<Record<string, unknown>> {
  const limitS = typeof timeoutS === "number" && Number.isFinite(timeoutS) ? Math.min(SLICE_WAIT_MAX_S, Math.max(0.05, timeoutS)) : SLICE_WAIT_DEFAULT_S;
  const deadline = Date.now() + limitS * 1000;
  while (!job.done && Date.now() < deadline && !meta?.signal?.aborted) {
    this.onProgress?.(job.handle, job.ctx.fraction ?? 0, job.ctx.stage ?? "", meta?.progressToken);
    await Promise.race([job.settled, this.pause(Math.min(250, Math.max(1, deadline - Date.now())), meta?.signal)]);
  }
  return this.workReply(job);
}

async function workCancel(this: Session, job: WorkJob): Promise<Record<string, unknown>> {
  if (job.done) return { ...this.workReply(job), reason: "That job had already finished." };
  if (!job.stoppable) {
    const after = CHANGES_NOTHING.has(job.tool) ? "It changes no part." : job.tool.startsWith("model_") || job.tool === "solid_new" ? "Once it is done, model_undo or model_goto takes the part back." : "Once it is done, plate_undo takes it back.";
    return refuse("job-running", `${job.tool} cannot stop part way; it finishes in the background, and slice_wait returns its result. ${after}`, { job: job.handle, status: "running" }, NEXT.slicewait);
  }
  job.stop.abort();
  await Promise.race([job.settled, this.pause(SLICE_WAIT_DEFAULT_S * 1000)]);
  if (!job.done) return { ok: true, job: job.handle, status: "cancelling", reason: job.tool === "plan_run" ? "The plan stops at the step it is on; a batch, build, or composite step is taken back, and the steps before it stay. Call slice_wait for the outcome." : "The work stops after the step it is on, and is then taken back. Call slice_wait for the outcome." };
  return this.workReply(job);
}

/** The methods this module adds to Session. */
export const workMethods = {
  detachable,
  startWorkJob,
  workReply,
  busyRefusal,
  planRun,
  runPlan,
  noteStage,
  workWait,
  workCancel,
};
