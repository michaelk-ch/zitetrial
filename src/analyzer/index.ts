import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Node, Project, ScriptTarget, ModuleKind, ModuleResolutionKind, SyntaxKind } from "ts-morph";
import { systemModelSchema } from "../system-model/schema.ts";
import type { CallGraph, Diagnostic, Relationship, SystemModel, TableOperation } from "../system-model/schema.ts";
import { integrationFor } from "./integrations.ts";
import { sqlTables } from "./sql.ts";
import { callable, callables, constant, constantKey, literal, origin, origins, property } from "./syntax.ts";
import type { Bindings } from "./syntax.ts";
import { contextBindings, literalFacts, walkBody } from "./flow.ts";
import { sqlDiagnostic, sqlTexts } from "./sql-text.ts";

type TableDefinition = {
  id: string; name: string; sdkName: string; description?: string;
  fields?: { definition: { type: string; template?: { tableId?: string } } }[];
};
type AppConfig = { name?: string; description?: string; accessMode?: string };
type Finding =
  | { kind: "table"; tableId: string; operation: TableOperation; evidence: string }
  | { kind: "integration"; service: NonNullable<ReturnType<typeof integrationFor>>; evidence: string }
  | { kind: "diagnostic"; diagnostic: Diagnostic };
type Scope = {
  fn: Node; bindings: Bindings; scanned: boolean;
  findings: Finding[];
  calls: { target: Scope; kind: "call" | "callback"; evidence: string }[];
  graph: CallGraph["nodes"][number];
};

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
  const callGraph: CallGraph = { entries: [], nodes: [] };
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
    integrations: [], endpoints: [], relationships: [], diagnostics: [], callGraph,
  };
  const sdkTables = new Map(schema.tables.map((table, i) => [table.sdkName, model.tables[i].id]));
  const sqlTableIds = new Map(schema.tables.map((table, i) => [
    table.sdkName[0].toUpperCase() + table.sdkName.slice(1), model.tables[i].id,
  ]));
  const relationships = new Map<string, Relationship>();
  const diagnostics = new Map<string, Diagnostic>();
  // Zite exposes linked records through SQL link tables, named by the sorted
  // PascalCase SDK table names. Inverse fields and multiple links share a table.
  const tablesById = new Map(schema.tables.map((table) => [table.id, table]));
  const linkTables = new Map<string, SystemModel["tables"][number]>();
  for (const table of schema.tables) {
    for (const field of table.fields ?? []) {
      if (field.definition.type !== "linked_record") continue;
      const targetId = field.definition.template?.tableId;
      const target = tablesById.get(targetId ?? "");
      if (!target) {
        const diagnostic: Diagnostic = {
          severity: "warning", code: "unresolved-table-reference",
          message: `Reference from table ${JSON.stringify(table.sdkName)} could not resolve schema table ID ${JSON.stringify(targetId ?? "<missing>")}.`,
          evidence: ["zite.schema.json"],
        };
        diagnostics.set(JSON.stringify(diagnostic), diagnostic);
        continue;
      }
      const sourceTableId = sdkTables.get(table.sdkName)!;
      const targetTableId = sdkTables.get(target.sdkName)!;
      relationships.set(`table-reference:${sourceTableId}->${targetTableId}`, {
        kind: "table-reference", sourceTableId, targetTableId, evidence: ["zite.schema.json"],
      });
      const pair = [table, target].sort((a, b) => a.sdkName < b.sdkName ? -1 : a.sdkName > b.sdkName ? 1 : 0);
      const name = pair.map((item) => item.sdkName[0].toUpperCase() + item.sdkName.slice(1)).join("");
      linkTables.set(name, {
        id: `table:link:${name}`, name,
        description: `Implicit link table between ${pair[0].name} and ${pair[1].name}.`,
      });
    }
  }
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
    const scopes = new Map<string, Scope>();
    const contexts = new Map<string, number>();
    const nodeKey = (node: Node) => `${relativePath(node)}:${node.getStart()}`;
    const functionName = (node: Node): string => {
      if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) || Node.isMethodDeclaration(node)) return node.getName() ?? "<anonymous>";
      const parent = node.getParent();
      if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)) return parent.getName();
      return "<callback>";
    };

    function context(fn: Node, args: Node[], inherited: Bindings, unknownArguments = false): Scope {
      const bindings = contextBindings(fn, args, inherited, unknownArguments);
      const callbacks = [...bindings].map(([parameter, targets]) => [nodeKey(parameter), targets.map(nodeKey)]).sort();
      const base = JSON.stringify([appId, nodeKey(fn), callbacks]);
      const constants = [...bindings.constants!].map(([parameter, value]) => [nodeKey(parameter), constantKey(value)] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      let key = JSON.stringify([base, constants]);
      let widened = false;
      if (!scopes.has(key) && (contexts.get(base) ?? 0) >= 32) {
        // Widen to unknown arguments rather than discard effects. Callback
        // identities stay intact, so their bodies remain reachable.
        bindings.constants!.clear();
        key = JSON.stringify([base, []]);
        widened = true;
      }
      const cached = scopes.get(key);
      const limitWarning = () => warning("analysis-context-limit", "Function exceeded 32 literal contexts; additional arguments are treated as unknown.", fn);
      if (cached) {
        if (widened && !cached.findings.some((finding) => finding.kind === "diagnostic" && finding.diagnostic.code === "analysis-context-limit")) {
          cached.findings.push(limitWarning());
        }
        return cached;
      }
      contexts.set(base, (contexts.get(base) ?? 0) + 1);
      const facts: CallGraph["nodes"][number]["arguments"] = {};
      for (const [parameter, value] of bindings.constants!) {
        const owner = parameter.getFirstAncestor(Node.isFunctionLikeDeclaration);
        const name = Node.isParameterDeclaration(parameter) ? parameter.getName() : parameter.getText();
        literalFacts(value, owner === fn ? name : `$capture.${owner ? functionName(owner) : "module"}.${name}`, facts);
      }
      const scope: Scope = {
        fn, bindings, scanned: false, findings: [], calls: [],
        graph: {
          id: `call:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
          name: functionName(fn), evidence: [location(fn)], arguments: facts, calls: [], accesses: [],
        },
      };
      if (widened) scope.findings.push(limitWarning());
      scopes.set(key, scope);
      return scope;
    }

    function scan(scope: Scope): Scope {
      if (scope.scanned) return scope;
      scope.scanned = true;
      const bindings = scope.bindings;
      const addTable = (name: string, operation: TableOperation, node: Node, sql = false) => {
        let tableId = (sql ? sqlTableIds : sdkTables).get(name);
        const linkTable = sql && !tableId ? linkTables.get(name) : undefined;
        if (linkTable) {
          tableId = linkTable.id;
          sqlTableIds.set(name, tableId);
          model.tables.push(linkTable);
        }
        if (tableId) scope.findings.push({ kind: "table", tableId, operation, evidence: location(node) });
        else if (name === "ziteUsers" || name === "pg_timezone_names") scope.findings.push(warning(
          name === "ziteUsers" ? "platform-table" : "system-table",
          `Table ${JSON.stringify(name)} belongs to ${name === "ziteUsers" ? "Zite" : "PostgreSQL"}, outside the application schema.`, node, "info",
        ));
        else scope.findings.push(warning("unresolved-table", `Table ${JSON.stringify(name)} is not in zite.schema.json.`, node));
      };
      walkBody(scope.fn, bindings, (node) => {
        const expression = node.getExpression();
        for (const source of origins(expression, new Set(), bindings)) {
          if (source.module === "zitejs/db" && source.members[0] === "zite") {
            const [, table, method] = source.members;
            if (table === "sql") {
              const unresolved = new Set<Node>();
              const options = constant(node.getArguments()[0], bindings);
              const query = options && typeof options === "object" ? options.query : undefined;
              const queries = typeof query === "string" ? [query] : sqlTexts(property(node.getArguments()[0], "query"), new Set(), bindings, unresolved);
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
        const targets = callables(expression, bindings);
        for (const target of targets) scope.calls.push({ target: context(target, node.getArguments(), bindings), kind: "call", evidence: location(node) });
        // Source-owned helpers invoke their bound callbacks at the actual
        // call site. Unknown/external code may invoke any passed callback.
        if (!targets.length) for (const argument of node.getArguments()) {
          for (const callback of callables(argument, bindings)) scope.calls.push({
            target: context(callback, [], bindings, true), kind: "callback", evidence: location(node),
          });
        }
      });
      scope.graph.calls = [...new Map(scope.calls.map((call) => {
        const fact = { nodeId: call.target.graph.id, kind: call.kind, evidence: [call.evidence] };
        return [JSON.stringify(fact), fact];
      })).values()];
      scope.graph.accesses = [...new Map(scope.findings.flatMap((finding) => {
        if (finding.kind === "diagnostic") return [];
        const fact: CallGraph["nodes"][number]["accesses"][number] = finding.kind === "table"
          ? { kind: "table-access", tableId: finding.tableId, operation: finding.operation, evidence: [finding.evidence] }
          : { kind: "integration-use", integrationId: `integration:${finding.service.provider}`, evidence: [finding.evidence] };
        return [[JSON.stringify(fact), fact] as const];
      })).values()];
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
      const entry = context(start, [], new Map(), true);
      callGraph.entries.push({ endpointId, nodeId: entry.graph.id });
      const visited = new Set<Scope>();
      const pending = [entry];
      while (pending.length) {
        const node = pending.pop()!;
        if (visited.has(node)) continue;
        visited.add(node);
        const scope = scan(node);
        scope.findings.forEach((finding) => record(endpointId, finding));
        pending.push(...scope.calls.map((call) => call.target));
      }
    }
    // Keep the graph about accesses and unresolved findings. Pure formatting
    // utilities add no provenance and need not inflate the serialized model.
    const retained = new Set([...scopes.values()].filter((scope) => scope.findings.some((finding) =>
      finding.kind !== "diagnostic" || finding.diagnostic.code !== "analysis-context-limit")).map((scope) => scope.graph.id));
    for (const entry of callGraph.entries) retained.add(entry.nodeId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const scope of scopes.values()) if (!retained.has(scope.graph.id) && scope.calls.some((call) => retained.has(call.target.graph.id))) {
        retained.add(scope.graph.id);
        changed = true;
      }
    }
    for (const scope of scopes.values()) if (retained.has(scope.graph.id)) {
      scope.graph.calls = scope.graph.calls.filter((call) => retained.has(call.nodeId));
      callGraph.nodes.push(scope.graph);
    }
  }
  model.relationships = [...relationships].sort(([a], [b]) => a.localeCompare(b)).map(([, relationship]) => relationship);
  const retainedDefinitions = new Set(callGraph.nodes.flatMap((node) => node.evidence));
  model.diagnostics = [...diagnostics.values()].filter((diagnostic) => diagnostic.code !== "analysis-context-limit" ||
    diagnostic.evidence.some((location) => retainedDefinitions.has(location)));
  for (const collection of [model.apps, model.tables, model.endpoints, model.integrations]) {
    collection.sort((a, b) => a.id.localeCompare(b.id));
  }
  for (const item of [...model.endpoints, ...model.integrations, ...model.relationships]) item.evidence.sort();
  model.diagnostics.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  callGraph.nodes.sort((a, b) => a.id.localeCompare(b.id));
  for (const node of callGraph.nodes) {
    node.calls.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    node.accesses.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return systemModelSchema.parse(model);
}
