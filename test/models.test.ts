import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatModelList, listPiModels, parseModelChoice, parsePiModelList, resumeModelFromConfig, suggestedModel } from "../src/core/models.ts";

const table = [
  "Warning: ignored",
  "provider   model                context  max-out  thinking  images",
  "anthropic  claude-sonnet-5      1M       128K     yes       yes",
  "grok-cli   grok-4.7             500K     30K      yes       yes",
  "vllm       qwen3.8-flash-next   262.1K   16.4K    yes       yes",
  "xai        grok-4.7             500K     500K     yes       yes",
].join("\n");

test("the pi model table keeps provider and id", () => {
  const models = parsePiModelList(table);
  assert.deepEqual(models, [
    { provider: "anthropic", id: "claude-sonnet-5" },
    { provider: "grok-cli", id: "grok-4.7" },
    { provider: "vllm", id: "qwen3.8-flash-next" },
    { provider: "xai", id: "grok-4.7" },
  ]);
  assert.match(formatModelList(models), /1 {2}anthropic\/claude-sonnet-5/);
  assert.deepEqual(parsePiModelList("No models available."), []);
});

test("a setup answer is a number, provider/model, or the saved model", () => {
  const models = parsePiModelList(table);
  assert.deepEqual(parseModelChoice("3", models), { provider: "vllm", id: "qwen3.8-flash-next" });
  assert.deepEqual(parseModelChoice("xai/grok-4.7", models), { provider: "xai", id: "grok-4.7" });
  assert.deepEqual(parseModelChoice("claude-sonnet-5", models), { provider: "anthropic", id: "claude-sonnet-5" });
  assert.deepEqual(parseModelChoice("", models, models[2]), models[2]);
  assert.deepEqual(suggestedModel(models, { provider: "xai", id: "grok-4.7" }), models[3]);
  assert.deepEqual(suggestedModel(models, { provider: "openai", id: "gone" }), models[0]);
  assert.throws(() => parseModelChoice("9", models), /from the list/);
  assert.throws(() => parseModelChoice("grok-4.7", models), /from the list/);
  assert.equal(resumeModelFromConfig({ provider: " vllm ", id: " qwen3.8-flash-next " })?.id, "qwen3.8-flash-next");
  assert.equal(resumeModelFromConfig("vllm/qwen"), undefined);
});

test("listPiModels reads the table pi prints", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teleport-models-"));
  try {
    const bin = join(root, "pi");
    await writeFile(bin, "#!/bin/sh\nprintf '%s\\n' 'provider  model  context' 'vllm  qwen3.8-flash-next  200K'\n");
    await chmod(bin, 0o755);
    assert.deepEqual(listPiModels(bin, process.env), [{ provider: "vllm", id: "qwen3.8-flash-next" }]);

    const missing = join(root, "empty");
    await writeFile(missing, "#!/bin/sh\necho 'No models available.'\n");
    await chmod(missing, 0o755);
    assert.throws(() => listPiModels(missing, process.env), /no available models/);

    const broken = join(root, "broken");
    await writeFile(broken, "#!/bin/sh\necho boom >&2\nexit 1\n");
    await chmod(broken, 0o755);
    assert.throws(() => listPiModels(broken, process.env), /could not list pi models: boom/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
