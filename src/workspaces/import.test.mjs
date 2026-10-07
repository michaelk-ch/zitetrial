import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverWorkspaces } from "./discover.ts";
import { importGitRepository, importWorkspace } from "./import.ts";

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

/** A local repository served at https://git.example.test/<name> via an insteadOf rewrite. */
async function gitRepository(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zite-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    if (content.symlink) await symlink(content.symlink, path.join(repo, file));
    else await writeFile(path.join(repo, file), content);
  }
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "init");
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${dir}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://git.example.test/" });
  t.after(() => { process.env = saved; });
  return { url: "https://git.example.test/repo", sha: git("rev-parse", "HEAD") };
}

test("clones a git repository to userdata/<project-name>/<HEAD sha> without .git", async (t) => {
  const root = await tempRoot(t);
  const { url, sha } = await gitRepository(t, { "zite.config.json": config("Grant Management"), "src/app.tsx": "x", "link": { symlink: "/etc/passwd" } });
  assert.deepEqual(await importGitRepository({ url: ` ${url} `, replace: false }, root), { workspace: "grant-management", revision: sha });
  const checkout = path.join(root, "grant-management", sha);
  assert.equal(await readFile(path.join(checkout, "src/app.tsx"), "utf8"), "x");
  assert.equal(await readFile(path.join(checkout, "link"), "utf8"), "/etc/passwd", "symlinks are plain files");
  assert.deepEqual((await readdir(checkout)).sort(), ["link", "src", "zite.config.json"]);
  await assert.rejects(importGitRepository({ url, replace: false }, root), /already exists/);
});

test("rejects bad repository URLs and failed clones without leaving files behind", async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(importGitRepository({ url: "github.com/zite/x", replace: false }, root), /Invalid repository URL/);
  for (const url of ["file:///tmp/x", "http://github.com/zite/x", "ext::sh -c touch% /tmp/pwned"]) {
    await assert.rejects(importGitRepository({ url, replace: false }, root), /must start with https:\/\/|Invalid repository URL/);
  }
  await assert.rejects(importGitRepository({ url: "https://127.0.0.1:1/missing.git", replace: false }, root), /git failed/);
  const { url } = await gitRepository(t, { "README.md": "no config" });
  await assert.rejects(importGitRepository({ url, replace: false }, root), /zite.config.json is missing/);
  assert.deepEqual(await readdir(root), []);
});
