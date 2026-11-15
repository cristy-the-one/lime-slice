/**
 * Pose's "Until contact" (docs/plan-contact-poses.md) off the UI thread: the shared solve, `firstContact`, on a copy of
 * the assembly, the members' model poses and their meshes. A solve on parts of a few thousand triangles takes a few
 * hundred milliseconds, and a grazing approach can take many more poses, so the window never waits on it.
 */
import type { Assembly } from "./assembly.ts";
import { firstContact, type ContactAnswer, type ContactPart } from "./contact.ts";
import type { Affine } from "./model-space.ts";

export interface ContactJob {
  id: number;
  assembly: Assembly;
  poses: [string, Affine][];
  parts: ContactPart[];
  object: string;
  dir: number;
  names: [string, string][];
}
export type ContactJobReply = { id: number; answer: ContactAnswer | { reason: string }; ms: number };

/** The job, answered on whatever thread runs it. */
export function solveContactJob(job: ContactJob): ContactJobReply {
  const start = performance.now();
  const poses = new Map(job.poses), names = new Map(job.names);
  const answer = firstContact(job.assembly, (id) => poses.get(id), job.parts, { object: job.object, dir: job.dir, against: "any", nameOf: (id) => names.get(id) ?? id });
  return { id: job.id, answer, ms: performance.now() - start };
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<ContactJob>) => void) | null;
  postMessage(data: ContactJobReply): void;
};

if (typeof window === "undefined") scope.onmessage = (ev: MessageEvent<ContactJob>) => scope.postMessage(solveContactJob(ev.data));
