import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Node, Project, ScriptTarget, ModuleKind, ModuleResolutionKind, SyntaxKind } from "ts-morph";
import { systemModelSchema } from "../system-model/schema.ts";
import type { Diagnostic, Relationship, SystemModel, TableOperation } from "../system-model/schema.ts";
import { integrationFor } from "./integrations.ts";
import { sqlTables } from "./sql.ts";
import { bodyOf, callable, callables, literal, origin, origins, property } from "./syntax.ts";
import { sqlDiagnostic, sqlTexts } from "./sql-text.ts";

type TableDefinition = { id: string; name: string; sdkName: string; description?: string };
type AppConfig = { name?: string; description?: string; accessMode?: string };
type Finding =
  | { kind: "table"; tableId: string; operation: TableOperation; evidence: string }
  | { kind: "integration"; service: NonNullable<ReturnType<typeof integrationFor>>; evidence: string }
  | { kind: "diagnostic"; diagnostic: Diagnostic };
type Scope = { findings: Finding[]; callees: Set<Node> };

const methodOperations = new Map<string, TableOperation>([
  ["findAll", "read"], ["findOne", "read"],
  ["create", "create"], ["bulkCreate", "create"],
  ["update", "update"], ["delete", "delete"],
]);

async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8"));
}

function addEvidence(evidence: string[], location: string) {
  if (!evidence.includes(location)) evidence.push(location);
}

/** Static analysis only: never imports or executes the analyzed repository. */
export async function analyzeRepository(
  directory: string,
  metadata: Partial<SystemModel["repository"]> = {},
): Promise<SystemModel> {
  const root = path.resolve(directory);
  const [schema, config, entries] = await Promise.all([
    json<{ tables: TableDefinition[] }>(path.join(root, "zite.schema.json")),
    json<{ project: { name: string } }>(path.join(root, "zite.config.json")),
    readdir(path.join(root, "apps"), { withFileTypes: true }),
  ]);
  const revision = path.basename(root);
  const model: SystemModel = {
    schemaVersion: 1,
    repository: {
      name: config.project.name,
      ...(/^[a-f\d]{40}$/i.test(revision) ? { commit: revision } : {}),
      ...metadata,
    },
    apps: [],
    tables: schema.tables.map((table) => ({
      id: `table:${table.sdkName}`, name: table.name,
      ...(table.description && { description: table.description }),
    })),
    integrations: [], endpoints: [], relationships: [], diagnostics: [],
  };
  const sdkTables = new Map(schema.tables.map((table, i) => [table.sdkName, model.tables[i].id]));
  const sqlTableIds = new Map(schema.tables.map((table, i) => [
    table.sdkName[0].toUpperCase() + table.sdkName.slice(1), model.tables[i].id,
  ]));
  const relationships = new Map<string, Relationship>();
  const diagnostics = new Map<string, Diagnostic>();
  const relativePath = (node: Node) => path.relative(root, node.getSourceFile().getFilePath()).split(path.sep).join("/");
  const location = (node: Node) => `${relativePath(node)}:${node.getStartLineNumber()}`;
  const warning = (code: string, message: string, node: Node, severity: Diagnostic["severity"] = "warning"): Finding => ({
    kind: "diagnostic", diagnostic: { severity, code, message, evidence: [location(node)] },
  });

  function record(endpointId: string, finding: Finding) {
    if (finding.kind === "diagnostic") {
      const diagnostic = finding.diagnostic;
      diagnostics.set(JSON.stringify(diagnostic), diagnostic);
      return;
    }
    const targetId = finding.kind === "table" ? finding.tableId : `integration:${finding.service.provider}`;
    const key = `${endpointId}->${targetId}`;
    if (finding.kind === "integration") {
      let integration = model.integrations.find((item) => item.id === targetId);
      if (!integration) {
        integration = { id: targetId, ...finding.service, evidence: [] };
        model.integrations.push(integration);
      }
      addEvidence(integration.evidence, finding.evidence);
    }
    let relationship = relationships.get(key);
    if (!relationship) {
      relationship = finding.kind === "table"
        ? { kind: "table-access", endpointId, tableId: targetId, operations: [finding.operation], evidence: [] }
        : { kind: "integration-use", endpointId, integrationId: targetId, evidence: [] };
      relationships.set(key, relationship);
    }
    if (relationship.kind === "table-access" && finding.kind === "table") {
      const operations = new Set([...relationship.operations, finding.operation]);
      if (operations.size > 1) operations.delete("unknown");
      relationship.operations = [...operations].sort();
    }
    addEvidence(relationship.evidence, finding.evidence);
  }

  for (const entry of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const appPath = path.join(root, "apps", entry.name);
    const appConfig = await json<AppConfig>(path.join(appPath, "zite.config.json"));
    const appId = `app:${entry.name}`;
    model.apps.push({
      id: appId, name: appConfig.name ?? entry.name,
      ...(appConfig.description && { description: appConfig.description }),
      visibility: appConfig.accessMode === "internal" ? "internal" :
        ["external", "public"].includes(appConfig.accessMode ?? "") ? "public" : "unknown",
    });

    // Each app has its own @/ alias. No installed dependencies or generated clients are needed.
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: {
        target: ScriptTarget.ESNext, module: ModuleKind.ESNext,
        moduleResolution: ModuleResolutionKind.Bundler,
        baseUrl: root,
        paths: { "@project/*": ["packages/*"], "@/*": [`apps/${entry.name}/src/*`] },
      },
    });
    project.addSourceFilesAtPaths([
      `${appPath}/src/**/*.ts`, `${appPath}/src/**/*.tsx`, `${root}/packages/**/*.ts`, `${root}/packages/**/*.tsx`,
      `!${root}/**/node_modules/**`, `!${root}/**/.zite/**`, `!${root}/**/*.d.ts`,
    ]);
    const scopes = new Map<Node, Scope>();

    function scan(scopeNode: Node): Scope {
      const cached = scopes.get(scopeNode);
      if (cached) return cached;
      const scope: Scope = { findings: [], callees: new Set() };
      scopes.set(scopeNode, scope);
      const addTable = (name: string, operation: TableOperation, node: Node, sql = false) => {
        const tableId = (sql ? sqlTableIds : sdkTables).get(name);
        if (tableId) scope.findings.push({ kind: "table", tableId, operation, evidence: location(node) });
        else if (name === "ziteUsers" || name === "pg_timezone_names") scope.findings.push(warning(
          name === "ziteUsers" ? "platform-table" : "system-table",
          `Table ${JSON.stringify(name)} belongs to ${name === "ziteUsers" ? "Zite" : "PostgreSQL"}, outside the application schema.`, node, "info",
        ));
        else scope.findings.push(warning("unresolved-table", `Table ${JSON.stringify(name)} is not in zite.schema.json.`, node));
      };
      const body = bodyOf(scopeNode);
      if (!body) return scope;
      function visit(node: Node) {
        if (Node.isFunctionLikeDeclaration(node)) {
          // Inline callbacks may run; local function declarations require a call.
          if (!Node.isFunctionDeclaration(node) && !Node.isVariableDeclaration(node.getParent())) scope.callees.add(node);
          return;
        }
        if (Node.isCallExpression(node)) {
          const expression = node.getExpression();
          for (const source of origins(expression)) {
            if (source.module === "zitejs/db" && source.members[0] === "zite") {
              const [, table, method] = source.members;
              if (table === "sql") {
                const unresolved = new Set<Node>();
                const queries = sqlTexts(property(node.getArguments()[0], "query"), new Set(), new Map(), unresolved);
                const results = queries.map(sqlTables);
                for (const { name, operation } of results.flatMap((result) => result.accesses)) addTable(name, operation, node, true);
                if (results.some((result) => result.partial || result.failed)) {
                  const diagnostic = results.some((result) => result.partial) ? sqlDiagnostic(queries, unresolved) : {
                    code: "unsupported-sql", message: "SQL syntax is not supported by the parser; quoted FROM/JOIN references are retained.",
                  };
                  scope.findings.push(warning(diagnostic.code, diagnostic.message, node));
                }
              } else if (table !== "auth" && method) {
                if (table === "<dynamic>") scope.findings.push(warning("dynamic-table", "Computed database table could not be resolved.", node));
                else {
                  const operation = methodOperations.get(method) ?? "unknown";
                  addTable(table, operation, node);
                  if (operation === "unknown") scope.findings.push(warning("unknown-db-method", `Unclassified database method: ${method}.`, node));
                }
              }
            } else {
              const service = integrationFor(source);
              if (service) scope.findings.push({ kind: "integration", service, evidence: location(node) });
            }
          }
          callables(expression).forEach((target) => scope.callees.add(target));
          for (const argument of node.getArguments()) {
            callables(argument).forEach((callback) => scope.callees.add(callback));
          }
        }
        node.forEachChild(visit);
      }
      visit(body);
      return scope;
    }

    const apiRoot = `${appPath}/src/api/`;
    const files = project.getSourceFiles().filter((file) => file.getFilePath().startsWith(apiRoot))
      .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));
    for (const file of files) {
      const endpointId = `endpoint:${relativePath(file).replace(/\.tsx?$/, "")}`;
      const definition = file.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => {
        const source = origin(call.getExpression());
        return source?.module === "zitejs/backend" && source.members.at(-1) === "createEndpoint";
      });
      const options = definition?.getArguments()[0];
      const description = literal(property(options, "description"));
      model.endpoints.push({
        id: endpointId, appId, name: file.getFilePath().slice(apiRoot.length).replace(/\.tsx?$/, ""),
        ...(description && { description }), evidence: [location(definition ?? file)],
      });
      const execute = property(options, "execute");
      const start = execute && callable(execute);
      if (!start) {
        record(endpointId, warning("unsupported-endpoint", "Could not resolve createEndpoint's execute function.", definition ?? file));
        continue;
      }
      const visited = new Set<Node>();
      const pending = [start];
      while (pending.length) {
        const node = pending.pop()!;
        if (visited.has(node)) continue;
        visited.add(node);
        const scope = scan(node);
        scope.findings.forEach((finding) => record(endpointId, finding));
        pending.push(...scope.callees);
      }
    }
  }
  model.relationships = [...relationships].sort(([a], [b]) => a.localeCompare(b)).map(([, relationship]) => relationship);
  model.diagnostics = [...diagnostics.values()];
  for (const collection of [model.apps, model.tables, model.endpoints, model.integrations]) {
    collection.sort((a, b) => a.id.localeCompare(b.id));
  }
  for (const item of [...model.endpoints, ...model.integrations, ...model.relationships]) item.evidence.sort();
  model.diagnostics.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return systemModelSchema.parse(model);
}
