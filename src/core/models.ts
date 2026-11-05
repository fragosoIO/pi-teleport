/**
 * The model a received session resumes on. It comes from `pi --list-models`
 * on this computer, which is the target when the session resumes here.
 */

import { spawnSync } from "node:child_process";

export interface ResumeModel {
  provider: string;
  id: string;
}

/** `provider/id`, the form `pi --model` accepts. The id may itself contain slashes. */
export function modelRef(model: ResumeModel): string {
  return `${model.provider}/${model.id}`;
}

export function resumeModelFromConfig(value: unknown): ResumeModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { provider?: unknown; id?: unknown };
  if (typeof record.provider !== "string" || typeof record.id !== "string") return undefined;
  const provider = record.provider.trim();
  const id = record.id.trim();
  if (!provider || !id) return undefined;
  return { provider, id };
}

/** Rows from `pi --list-models`. Lines before the header, including warnings, are ignored. */
export function parsePiModelList(text: string): ResumeModel[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const header = lines.findIndex((line) => {
    const parts = line.split(/\s{2,}/);
    return parts[0] === "provider" && parts[1] === "model";
  });
  if (header < 0) return [];
  const models: ResumeModel[] = [];
  for (const line of lines.slice(header + 1)) {
    const parts = line.split(/\s{2,}/);
    const provider = parts[0];
    const id = parts[1];
    if (!provider || !id) continue;
    models.push({ provider, id });
  }
  return models;
}

export function formatModelList(models: readonly ResumeModel[]): string {
  const width = String(models.length).length;
  return models.map((model, index) => `  ${String(index + 1).padStart(width)}  ${modelRef(model)}`).join("\n");
}

/** A number, `provider/id`, or a model id that appears once. Enter keeps `fallback`. */
export function parseModelChoice(input: string, models: readonly ResumeModel[], fallback?: ResumeModel): ResumeModel {
  const value = input.trim();
  if (!value) {
    if (!fallback) throw new Error("choose a model from the list");
    return fallback;
  }
  if (/^\d+$/.test(value)) {
    const model = models[Number(value) - 1];
    if (!model) throw new Error("choose a model from the list");
    return model;
  }
  const exact = models.filter((model) => modelRef(model) === value);
  if (exact.length === 1) return exact[0];
  const byId = models.filter((model) => model.id === value);
  if (byId.length === 1) return byId[0];
  throw new Error("choose a number or provider/model from the list");
}

/** The saved model when it is still listed, otherwise the first model pi printed. */
export function suggestedModel(models: readonly ResumeModel[], current?: ResumeModel): ResumeModel {
  const saved = current && models.find((model) => model.provider === current.provider && model.id === current.id);
  const first = saved ?? models[0];
  if (!first) throw new Error("pi has no available models");
  return first;
}

/** Models pi can use on this computer. The table is `pi --list-models`. */
export function listPiModels(piPath: string, env: NodeJS.ProcessEnv): ResumeModel[] {
  const result = spawnSync(piPath, ["--list-models"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = result.stdout ?? "";
  const models = parsePiModelList(stdout);
  if (models.length > 0) return models;
  if (result.error) throw new Error(`could not list pi models: ${result.error.message}`);
  const detail = (result.stderr ?? "").trim().split("\n").find((line) => line.trim().length > 0);
  if (result.status !== 0) throw new Error(detail ? `could not list pi models: ${detail}` : "could not list pi models");
  throw new Error("pi has no available models. Log in with pi, then run pi-teleport setup again");
}
