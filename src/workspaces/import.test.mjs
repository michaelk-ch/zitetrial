import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverWorkspaces } from "./discover.ts";
import { importWorkspace } from "./import.ts";

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zite-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "userdata");
}

const config = (name) => JSON.stringify({ project: { name, basePublicIdentifier: "0efb0adcafa46147" } });
const response = (headSha, files) => JSON.stringify({ headSha, files: Object.entries(files).map(([p, content]) => ({ path: p, content })) });
const project = (headSha, files, name = "Baden Dampft") => response(headSha, { "zite.config.json": config(name), ...files });

test("writes files to userdata/<project-name>/<headSha>", async (t) => {
  const root = await tempRoot(t);
  const result = await importWorkspace({ json: project("abc123", { "src/app.tsx": "x" }), replace: false }, root);
  assert.deepEqual(result, { workspace: "baden-dampft", revision: "abc123", fileCount: 2 });
  assert.equal(await readFile(path.join(root, "baden-dampft/abc123/src/app.tsx"), "utf8"), "x");
  assert.deepEqual(await discoverWorkspaces(root), [{ id: "baden-dampft", revisions: ["abc123"] }]);
});

test("derives the workspace name from project.name", async (t) => {
  const root = await tempRoot(t);
  const name = async (projectName) => (await importWorkspace({ json: project("s", {}, projectName), replace: true }, root)).workspace;
  assert.equal(await name("  Zürich Café & Bar!  "), "zurich-cafe-bar");
  assert.equal(await name("myApp_v2.0"), "myapp-v2-0");
  await assert.rejects(name("!!!"), /no letters or digits/);
  await assert.rejects(name(""), /non-empty project.name/);
});

test("requires a root zite.config.json with a project name", async (t) => {
  const root = await tempRoot(t);
  const attempt = (files) => importWorkspace({ json: response("s", files), replace: false }, root);
  await assert.rejects(attempt({ "apps/a/zite.config.json": config("A") }), /zite.config.json is missing/);
  await assert.rejects(attempt({ "zite.config.json": "{" }), /must be JSON with a non-empty project.name/);
  await assert.rejects(attempt({ "zite.config.json": "{}" }), /must be JSON with a non-empty project.name/);
});

test("refuses existing workspaces unless replacing, and replaces all revisions", async (t) => {
  const root = await tempRoot(t);
  await importWorkspace({ json: project("bbb", { a: "1" }), replace: false }, root);
  await assert.rejects(importWorkspace({ json: project("aaa", { a: "2" }), replace: false }, root), /already exists/);
  await importWorkspace({ json: project("aaa", { a: "2" }), replace: true }, root);
  assert.deepEqual(await discoverWorkspaces(root), [{ id: "baden-dampft", revisions: ["aaa"] }]);
});

test("rejects unsafe input without leaving files behind", async (t) => {
  const root = await tempRoot(t);
  for (const filePath of ["../escape", "/etc/passwd", "a/../../b", "C:/x", ""]) {
    await assert.rejects(importWorkspace({ json: project("s", { [filePath]: "" }), replace: false }, root), /Unsafe file path/);
  }
  await assert.rejects(importWorkspace({ json: project("../s", {}), replace: false }, root), /Unexpected format/);
  await assert.rejects(importWorkspace({ json: "{", replace: false }, root), /Invalid JSON/);
  // A file and a directory with the same path fail while staging.
  await assert.rejects(importWorkspace({ json: project("s", { a: "", "a/b": "" }), replace: false }, root), /Writing files failed/);
  assert.deepEqual(await readdir(root).catch(() => []), []);
});
