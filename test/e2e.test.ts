import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { after, before, type TestContext } from "node:test";
import { assertExecError, cliEnv } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

// Response fields used by the assertions below. Runtime checks stay in each test.
type Resource = { id: string };
type Collection = Resource & { name: string };
type Scene = {
  metadata: Collection & { collection: string; pinned: boolean };
};
type Page<T> = { data: T[]; count?: number };
type SceneContent = {
  type: string;
  elements: Resource[];
  appState: { viewBackgroundColor: string };
};
type Identity = { keyType: string; workspace: Collection };

const liveApiEnv = {
  EXCALIDRAW_API_URL: process.env.EXCALIDRAW_API_URL,
  EXCALIDRAW_API_KEY: process.env.EXCALIDRAW_API_KEY,
};

const hasLiveApiEnv = Boolean(liveApiEnv.EXCALIDRAW_API_URL && liveApiEnv.EXCALIDRAW_API_KEY);
const skipMessage = "Set EXCALIDRAW_API_URL and EXCALIDRAW_API_KEY to run e2e tests.";
const liveTest = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, { skip: hasLiveApiEnv ? false : skipMessage }, fn);
const debugResponses = process.env.EXCALIDRAW_E2E_DEBUG === "1";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const collectionName = `cli-e2e-collection-${suffix}`;
const updatedCollectionName = `cli-e2e-collection-updated-${suffix}`;
const sceneName = `cli-e2e-scene-${suffix}`;
const updatedSceneName = `cli-e2e-scene-updated-${suffix}`;
const collectionSceneName = `cli-e2e-collection-scene-${suffix}`;

let collectionId: string | undefined;
let sceneId: string | undefined;
let collectionSceneId: string | undefined;
let importedSceneId: string | undefined;
let inviteId: string | undefined;
let tempDir: string | undefined;
let putFile: string | undefined;
let patchFile: string | undefined;
let outFile: string | undefined;

// Setup and cleanup are hooks, so a run filtered to some tests still gets its files and deletes what it created.
// Top-level hooks receive the root test's context, which has diagnostic().
before(async (context) => {
  const t = context as TestContext;
  if (!hasLiveApiEnv) {
    return;
  }
  t.diagnostic(`API URL: ${liveApiEnv.EXCALIDRAW_API_URL}`);
  if (debugResponses) {
    t.diagnostic("response diagnostics enabled with EXCALIDRAW_E2E_DEBUG=1");
  }
  tempDir = await mkdtemp(join(tmpdir(), "excalidraw-cli-e2e-"));
  t.diagnostic(`tempDir: ${tempDir}`);
  putFile = join(tempDir, "scene-put.json");
  patchFile = join(tempDir, "scene-patch.json");
  outFile = join(tempDir, "scene-content-out.json");
  await writeFile(putFile, `${JSON.stringify(createPutContent(), null, 2)}\n`, "utf8");
  await writeFile(patchFile, `${JSON.stringify(createPatchContent(), null, 2)}\n`, "utf8");
});

liveTest("whoami", async (t) => {
  const identity = await runStepJson<Identity>(t, "Whoami", ["whoami"]);
  assert.ok(identity.workspace.id, "whoami should return the workspace id");
  assert.ok(["personal", "workspace"].includes(identity.keyType));
  t.diagnostic(`keyType: ${identity.keyType}, workspace: ${identity.workspace.name}`);
});

liveTest("collections list", async (t) => {
  const result = await runStepJson<Page<Collection>>(t, "List collections", ["collections", "list", "--limit", "20", "--offset", "0"]);
  assert.ok(Array.isArray(result.data), "collections list should return data array");
});

liveTest("collections create", async (t) => {
  const collection = await runStepJson<Collection>(t, "Create collection", ["collections", "create", "--name", collectionName]);
  collectionId = collection.id;
  t.diagnostic(`collectionId: ${collectionId}`);
  assert.ok(collectionId, "collection create response should include id");
  assert.equal(collection.name, collectionName);
});

liveTest("collections get", async (t) => {
  assert.ok(collectionId, "previous step should create collectionId");
  const collection = await runStepJson<Collection>(t, "Get collection", ["collections", "get", collectionId]);
  assert.equal(collection.id, collectionId);
  assert.equal(collection.name, collectionName);
});

liveTest("collections update", async (t) => {
  assert.ok(collectionId, "previous step should create collectionId");
  const collection = await runStepJson<Collection>(t, "Update collection", [
    "collections",
    "update",
    collectionId,
    "--name",
    updatedCollectionName,
  ]);
  assert.equal(collection.id, collectionId);
  assert.equal(collection.name, updatedCollectionName);
});

liveTest("scenes list", async (t) => {
  const result = await runStepJson<Page<Scene>>(t, "List scenes", ["scenes", "list", "--limit", "20", "--offset", "0"]);
  assert.ok(Array.isArray(result.data), "scenes list should return data array");
});

liveTest("scenes create", async (t) => {
  assert.ok(collectionId, "previous step should create collectionId");
  const scene = await runStepJson<Scene>(t, "Create scene", [
    "scenes",
    "create",
    "--name",
    sceneName,
    "--collection-id",
    collectionId,
  ]);
  sceneId = scene.metadata.id;
  t.diagnostic(`sceneId: ${sceneId}`);
  assert.ok(sceneId, "scene create response should include metadata.id");
  assert.equal(scene.metadata.name, sceneName);
  assert.equal(scene.metadata.collection, collectionId);
});

liveTest("scenes get", async (t) => {
  assert.ok(sceneId, "previous step should create sceneId");
  const scene = await runStepJson<Scene>(t, "Get scene", ["scenes", "get", sceneId]);
  assert.equal(scene.metadata.id, sceneId);
  assert.equal(scene.metadata.name, sceneName);
});

liveTest("scenes content put", async (t) => {
  assert.ok(sceneId, "previous step should create sceneId");
  assert.ok(putFile, "setup should create putFile");
  const content = await runStepJson<SceneContent>(t, "Put scene content", ["scenes", "content", "put", sceneId, "--file", putFile]);
  assert.equal(content.type, "excalidraw");
  assert.equal(content.elements.length, 1);
  assert.ok(hasElement(content, "rectElement0000000001"));
});

liveTest("scenes content get", async (t) => {
  assert.ok(sceneId, "previous step should create sceneId");
  const content = await runStepJson<SceneContent>(t, "Get scene content", ["scenes", "content", "get", sceneId]);
  assert.equal(content.type, "excalidraw");
  assert.ok(hasElement(content, "rectElement0000000001"));
});

liveTest("scenes content patch", async (t) => {
  assert.ok(sceneId, "previous step should create sceneId");
  assert.ok(patchFile, "setup should create patchFile");
  const content = await runStepJson<SceneContent>(t, "Patch scene content", [
    "scenes",
    "content",
    "patch",
    sceneId,
    "--file",
    patchFile,
  ]);
  assert.ok(hasElement(content, "rectElement0000000001"), "patch should preserve existing elements");
  assert.ok(hasElement(content, "ellipseElement0000001"), "patch should add new elements");
  assert.equal(content.appState.viewBackgroundColor, "#f0f0f0");
});

liveTest("scenes content get writes output file", async () => {
  assert.ok(sceneId, "previous step should create sceneId");
  assert.ok(outFile, "setup should create outFile");
  await runCli(["scenes", "content", "get", sceneId, "--out", outFile]);
  const content: SceneContent = JSON.parse(await readFile(outFile, "utf8"));
  assert.ok(hasElement(content, "ellipseElement0000001"));
});

liveTest("scenes update", async (t) => {
  assert.ok(sceneId, "previous step should create sceneId");
  const scene = await runStepJson<Scene>(t, "Update scene", ["scenes", "update", sceneId, "--name", updatedSceneName, "--pinned"]);
  assert.equal(scene.metadata.id, sceneId);
  assert.equal(scene.metadata.name, updatedSceneName);
  assert.equal(scene.metadata.pinned, true);

  const unpinned = await runStepJson<Scene>(t, "Unpin scene", ["scenes", "update", sceneId, "--no-pinned"]);
  assert.equal(unpinned.metadata.pinned, false);
});

liveTest("scenes create --file writes content in one step", async (t) => {
  assert.ok(collectionId, "previous step should create collectionId");
  assert.ok(putFile, "setup should create putFile");
  const scene = await runStepJson<Scene>(t, "Create scene with content", [
    "scenes",
    "create",
    "--name",
    `${sceneName}-imported`,
    "--collection-id",
    collectionId,
    "--file",
    putFile,
  ]);
  importedSceneId = scene.metadata.id;
  t.diagnostic(`importedSceneId: ${importedSceneId}`);
  const content = await runStepJson<SceneContent>(t, "Get imported content", ["scenes", "content", "get", importedSceneId]);
  assert.ok(hasElement(content, "rectElement0000000001"), "created scene should contain the imported element");
});

liveTest("scenes list --all and table output", async (t) => {
  assert.ok(sceneId, "previous step should create sceneId");
  const result = await runStepJson<Page<Scene>>(t, "List all scenes", ["scenes", "list", "--all", "--limit", "2"]);
  assert.equal(result.count, result.data.length);
  assert.ok(result.data.some((item) => item.metadata.id === sceneId), "--all should include the created scene");

  const { stdout } = await runCli(["scenes", "list", "--limit", "3", "--output", "table"]);
  assert.match(stdout, /^ID\s+NAME\s+COLLECTION/);
});

liveTest("collections scenes list", async (t) => {
  assert.ok(collectionId, "previous step should create collectionId");
  assert.ok(sceneId, "previous step should create sceneId");
  const result = await runStepJson<Page<Scene>>(t, "List collection scenes", [
    "collections",
    "scenes",
    "list",
    collectionId,
    "--limit",
    "20",
    "--offset",
    "0",
  ]);
  assert.ok(Array.isArray(result.data), "collection scenes list should return data array");
  assert.ok(
    result.data.some((item) => item.metadata.id === sceneId),
    "collection scenes list should include created scene",
  );
});

liveTest("collections scenes create", async (t) => {
  assert.ok(collectionId, "previous step should create collectionId");
  const scene = await runStepJson<Scene>(t, "Create collection scene", [
    "collections",
    "scenes",
    "create",
    collectionId,
    "--name",
    collectionSceneName,
  ]);
  collectionSceneId = scene.metadata.id;
  t.diagnostic(`collectionSceneId: ${collectionSceneId}`);
  assert.ok(collectionSceneId, "collection-scoped scene create response should include metadata.id");
  assert.equal(scene.metadata.collection, collectionId);
});

liveTest("workspace get", async (t) => {
  const workspace = await runStepJson<Resource>(t, "Get workspace", ["workspace", "get"]);
  assert.ok(workspace.id, "workspace get should return id");
});

liveTest("workspace users list and get", async (t) => {
  const users = await runStepJson<Page<Resource>>(t, "List workspace users", [
    "workspace",
    "users",
    "list",
    "--limit",
    "20",
    "--offset",
    "0",
  ]);
  assert.ok(Array.isArray(users.data), "workspace users list should return data array");
  if (users.data[0]?.id) {
    t.diagnostic(`userId: ${users.data[0].id}`);
    const user = await runStepJson<Resource>(t, "Get workspace user", ["workspace", "users", "get", users.data[0].id]);
    assert.equal(user.id, users.data[0].id);
  } else {
    t.diagnostic("workspace users list returned no users; skipped get");
  }
});

liveTest("workspace invites create-link", async (t) => {
  const invite = await runStepJson<Resource>(t, "Create invite link", [
    "workspace",
    "invites",
    "create-link",
    "--role",
    "member",
    "--max-uses",
    "1",
  ]);
  inviteId = invite.id;
  t.diagnostic(`inviteId: ${inviteId}`);
  assert.ok(inviteId, "invite link create response should include id");
});

liveTest("workspace invites list", async (t) => {
  assert.ok(inviteId, "previous step should create inviteId");
  const invites = await runStepJson<Page<Resource>>(t, "List invites", ["workspace", "invites", "list", "--limit", "20", "--offset", "0"]);
  assert.ok(Array.isArray(invites.data), "workspace invites list should return data array");
  assert.ok(invites.data.some((item) => item.id === inviteId), "invites list should include created invite");
});

liveTest("workspace invites get", async (t) => {
  assert.ok(inviteId, "previous step should create inviteId");
  const invite = await runStepJson<Resource>(t, "Get invite", ["workspace", "invites", "get", inviteId]);
  assert.equal(invite.id, inviteId);
});

liveTest("workspace invites update", async (t) => {
  assert.ok(inviteId, "previous step should create inviteId");
  const invite = await runStepJson<Resource>(t, "Update invite", [
    "workspace",
    "invites",
    "update",
    inviteId,
    "--role",
    "member",
    "--max-uses",
    "2",
  ]);
  assert.equal(invite.id, inviteId);
});

liveTest("logs list", async (t) => {
  const logs = await runStepJson<{ logs: unknown[] }>(t, "List logs", ["logs", "list", "--limit", "20"]);
  assert.ok(Array.isArray(logs.logs), "logs list should return logs array");
});

after(async (context) => {
  const t = context as TestContext;
  const cleanupErrors = [];

  if (inviteId) {
    try {
      t.diagnostic(`delete inviteId: ${inviteId}`);
      await runCli(["workspace", "invites", "delete", inviteId]);
    } catch (error) {
      cleanupErrors.push(`invite ${inviteId}: ${formatExecError(error)}`);
    }
  }

  for (const id of [collectionSceneId, importedSceneId, sceneId].filter((id): id is string => Boolean(id))) {
    try {
      t.diagnostic(`delete sceneId: ${id}`);
      await runCli(["scenes", "delete", id]);
    } catch (error) {
      cleanupErrors.push(`scene ${id}: ${formatExecError(error)}`);
    }
  }

  if (collectionId) {
    try {
      t.diagnostic(`delete collectionId: ${collectionId}`);
      await runCli(["collections", "delete", collectionId]);
    } catch (error) {
      cleanupErrors.push(`collection ${collectionId}: ${formatExecError(error)}`);
    }
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true });
  }

  if (cleanupErrors.length > 0) {
    throw new Error(`E2E cleanup failed:\n${cleanupErrors.join("\n")}`);
  }

  if (hasLiveApiEnv) {
    t.diagnostic("cleanup finished");
  }
});

async function runStepJson<T>(t: TestContext, label: string, args: string[]): Promise<T> {
  const { stdout } = await runCli(args);
  const parsed: T = JSON.parse(stdout);

  if (debugResponses) {
    t.diagnostic(`${label} response: ${JSON.stringify(summarizeResponse(parsed))}`);
  }

  return parsed;
}

async function runCli(args: string[]) {
  try {
    return await execFileAsync(process.execPath, [cliPath, ...args], {
      env: cliEnv(liveApiEnv),
      maxBuffer: 1024 * 1024 * 10,
    });
  } catch (error) {
    assertExecError(error);
    error.message = `${error.message}\ncommand: excalidraw ${args.join(" ")}\nstdout:\n${
      error.stdout ?? ""
    }\nstderr:\n${error.stderr ?? ""}`;
    throw error;
  }
}

function hasElement(content: SceneContent, id: string) {
  return content.elements?.some((element) => element.id === id);
}

function summarizeResponse(value: unknown) {
  return summarizeValue(value, 0);
}

function summarizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return summarizePrimitive(value);
  }

  if (Array.isArray(value)) {
    if (depth === 0) {
      return value.map((item) => summarizeValue(item, depth + 1));
    }

    return {
      length: value.length,
      first: value.length > 0 ? summarizeValue(value[0], depth + 1) : undefined,
    };
  }

  const summary: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined || typeof item !== "object") {
      summary[key] = summarizeField(key, item);
      continue;
    }

    if (Array.isArray(item)) {
      summary[key] = summarizeValue(item, depth + 1);
      continue;
    }

    summary[key] = depth < 2 ? summarizeValue(item, depth + 1) : summarizeObjectScalars(item);
  }

  return summary;
}

function summarizeObjectScalars(value: object) {
  const summary: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined || typeof item !== "object") {
      summary[key] = summarizeField(key, item);
    }
  }

  return summary;
}

function summarizeField(key: string, value: unknown) {
  if (/key|password|secret|token/i.test(key)) {
    return "[redacted]";
  }

  return summarizePrimitive(value);
}

function summarizePrimitive(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function createPutContent() {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://plus.excalidraw.com",
    elements: [
      {
        id: "rectElement0000000001",
        type: "rectangle",
        x: 100,
        y: 100,
        width: 200,
        height: 150,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "#ffffff",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 123456,
        version: 1,
        versionNonce: 789012,
        index: "a0",
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
      },
    ],
    appState: {
      viewBackgroundColor: "#ffffff",
      lockedMultiSelections: {},
    },
    files: {},
    sceneVersion: "2",
  };
}

function createPatchContent() {
  return {
    elements: [
      {
        id: "ellipseElement0000001",
        type: "ellipse",
        x: 400,
        y: 200,
        width: 150,
        height: 150,
        angle: 0,
        strokeColor: "#e03131",
        backgroundColor: "#ffc9c9",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 654321,
        version: 1,
        versionNonce: 210987,
        index: "a1",
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
      },
    ],
    appState: {
      viewBackgroundColor: "#f0f0f0",
    },
  };
}

function formatExecError(error: unknown) {
  if (error instanceof Error) {
    return `${error.message}\n${"stderr" in error ? (error.stderr ?? "") : ""}`.trim();
  }

  return String(error);
}
