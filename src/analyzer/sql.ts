import sqlParser from "node-sql-parser";
import { DYNAMIC } from "./syntax.ts";

const parser = new sqlParser.Parser();
const tokensPattern = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\$\d+|[A-Za-z_][\w$]*|[^\s]/g;

export type SqlTables = { names: string[]; partial: boolean; failed: boolean };

/** Zite SQL is read-only PostgreSQL. CTE aliases are not physical tables. */
export function sqlTables(query: string): SqlTables {
  const partial = query.includes(DYNAMIC);
  // The parser rejects casts on $n parameters. Their values do not affect tables.
  const normalized = query.replace(tokensPattern, (token) => /^\$\d+$/.test(token) ? "NULL" : token);
  try {
    const ast = parser.astify(normalized, { database: "Postgresql" });
    const names = new Set<string>();
    // Walk FROM nodes with lexical CTE scope; tableList also includes CTE aliases.
    function collect(value: unknown, inherited = new Set<string>()) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) return value.forEach((child) => collect(child, inherited));
      const record = value as Record<string, unknown>;
      const aliases = new Set(inherited);
      if (Array.isArray(record.with)) {
        for (const cte of record.with) {
          if (cte.recursive) aliases.add(cte.name.value);
          collect(cte.stmt, aliases);
          aliases.add(cte.name.value);
        }
      }
      if (typeof record.table === "string" && "db" in record &&
        (record.db || !aliases.has(record.table)) && !record.table.includes(DYNAMIC)) {
        names.add(record.table);
      }
      for (const [key, child] of Object.entries(record)) if (key !== "with") collect(child, aliases);
    }
    collect(ast);
    return { names: [...names], partial, failed: false };
  } catch {
    // Incomplete filters often prevent parsing an otherwise clear FROM/JOIN.
    // Tokenize first so comments and string literals cannot invent table access.
    const tokens = query.match(tokensPattern) ?? [];
    const names = new Set<string>();
    for (let i = 0; i < tokens.length - 1; i++) {
      if (!/^(from|join)$/i.test(tokens[i])) continue;
      const token = tokens[i + 1];
      // Only quoted identifiers: unquoted tokens can be CTEs or SQL functions.
      if (token.startsWith('"') && !token.includes(DYNAMIC)) names.add(token.slice(1, -1).replaceAll('""', '"'));
    }
    return { names: [...names], partial, failed: true };
  }
}
