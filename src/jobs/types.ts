// ISO 9001-inspired process map types.
// A Job is a process; each ProcessStep declares explicit typed inputs and
// outputs so the output contract of one step feeds the input of the next.

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface StepIO {
  key: string;
  type: string;
  description: string;
}

export interface ProcessStep {
  id: string;
  name: string;
  description: string;
  inputs: StepIO[];
  outputs: StepIO[];
}

export interface Job {
  id: string;
  name: string;
  description: string;
  trigger: string;
  steps: ProcessStep[];
}

export interface StepRun {
  stepId: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  note?: string;
}

export interface JobRun {
  id: string;
  jobId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  stepRuns: StepRun[];
}
