import { Node, SyntaxKind } from "ts-morph";
import { arrayElements, bindArguments, bodyOf, callables, declarations, DYNAMIC, literal, returns, stringValues, unwrap, values } from "./syntax.ts";
import type { Bindings } from "./syntax.ts";

// Bound combinations of independent choices. A sentinel keeps truncation visible.
const MAX_VARIANTS = 128;
export const EXPANSION_LIMIT = `${DYNAMIC}limit`;
function combine(left: string[], right: string[], separator = ""): string[] {
  if (!left.length || !right.length) return [];
  const result = new Set<string>();
  // Cover both sides before filling the Cartesian product. A large set of
  // filter combinations must not crowd every later table choice out of the cap.
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    result.add(left[i % left.length] + separator + right[i % right.length]);
    if (result.size > MAX_VARIANTS) return [...result].slice(0, MAX_VARIANTS).concat(EXPANSION_LIMIT);
  }
  for (const a of left) for (const b of right) {
    result.add(a + separator + b);
    if (result.size > MAX_VARIANTS) return [...result].slice(0, MAX_VARIANTS).concat(EXPANSION_LIMIT);
  }
  return [...result];
}

function pushedBefore(reference: Node, before: Node): Node[] {
  const variable = declarations(reference).find(Node.isVariableDeclaration);
  const owner = variable?.getFirstAncestor(Node.isFunctionLikeDeclaration);
  const pushed: Node[] = [];
  const body = owner && bodyOf(owner);
  body?.forEachDescendant((child, traversal) => {
    if (Node.isFunctionLikeDeclaration(child)) { traversal.skip(); return; }
    if (!Node.isCallExpression(child) || child.getStart() >= before.getStart()) return;
    const call = child.getExpression();
    if (Node.isPropertyAccessExpression(call) && call.getName() === "push" &&
      declarations(call.getExpression()).includes(variable!)) pushed.push(...child.getArguments());
  });
  return pushed;
}

export function sqlDiagnostic(queries: string[], unresolved: Set<Node>): { code: string; message: string } {
  const nodes = [...unresolved];
  const snippets = [...new Set(nodes.map((node) => node.getText().replace(/\s+/g, " ").slice(0, 100)))].slice(0, 3);
  const detail = snippets.length ? ` Unresolved: ${snippets.join("; ")}.` : "";
  if (queries.some((query) => query.includes(EXPANSION_LIMIT))) return {
    code: "sql-expansion-limit", message: `SQL exceeded ${MAX_VARIANTS} static combinations; some accesses may be missing.${detail}`,
  };
  if (nodes.some((node) => declarations(node).some(Node.isParameterDeclaration))) return {
    code: "sql-helper-argument", message: `SQL depends on a caller-supplied helper argument.${detail}`,
  };
  if (nodes.some((node) => Node.isBinaryExpression(node) || declarations(node).some((declaration) => {
    const parent = declaration.getParent();
    return Node.isVariableDeclarationList(parent) && parent.getDeclarationKind() !== "const";
  }) || (Node.isCallExpression(node) && Node.isPropertyAccessExpression(node.getExpression()) && node.getExpression().getText().endsWith(".get")))) return {
    code: "sql-builder-state", message: `SQL depends on accumulated mutable state.${detail}`,
  };
  return { code: "dynamic-sql", message: `SQL contains an unresolved expression; some accesses may be missing.${detail}` };
}

/** Recover possible queries from constants, lookup maps, templates, and array joins. */
export function sqlTexts(node: Node | undefined, seen = new Set<Node>(), bindings: Bindings = new Map(), unresolved = new Set<Node>()): string[] {
  if (!node) return [DYNAMIC];
  node = unwrap(node);
  const unknown = () => { unresolved.add(node); return [DYNAMIC]; };
  if (seen.has(node)) return unknown();
  seen.add(node);
  const follow = (value: Node) => sqlTexts(value, new Set(seen), bindings, unresolved);
  // Scalars and narrowed literal unions can come from type metadata (e.g. an
  // input schema), whose property initializers aren't runtime SQL expressions.
  const type = node.getType();
  if (!Node.isNumericLiteral(node) && (type.isNumber() || type.isNumberLiteral())) return ["0"];
  const types = type.isUnion() ? type.getUnionTypes() : [type];
  if (types.every((type) => type.isStringLiteral()) && !declarations(node).some((declaration) => bindings.has(declaration))) {
    return types.map((type) => String(type.getLiteralValue()));
  }
  const candidates = values(node, new Set(), bindings);
  if (candidates.length !== 1 || candidates[0] !== node) return [...new Set(candidates.flatMap(follow))];
  const text = literal(node);
  if (text !== undefined) return [text];
  if ([SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword].includes(node.getKind())) return [node.getText()];
  if (Node.isIdentifier(node)) {
    const variable = declarations(node).find(Node.isVariableDeclaration);
    const list = variable?.getParent();
    const owner = variable?.getFirstAncestor(Node.isFunctionLikeDeclaration);
    if (variable && Node.isVariableDeclarationList(list) && list.getDeclarationKind() !== "const" && owner) {
      const assignments: Node[] = variable.getInitializer() ? [variable.getInitializer()!] : [];
      let unsupported = false;
      bodyOf(owner)?.forEachDescendant((child) => {
        if (!Node.isIdentifier(child) || !declarations(child).includes(variable)) return;
        if (child.getFirstAncestor(Node.isFunctionLikeDeclaration) === owner && child.getStart() >= node.getStart()) return;
        const parent = child.getParent();
        if (Node.isBinaryExpression(parent) && parent.getLeft() === child &&
          parent.getOperatorToken().getKind() >= SyntaxKind.FirstAssignment && parent.getOperatorToken().getKind() <= SyntaxKind.LastAssignment) {
          if (parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken && child.getFirstAncestor(Node.isFunctionLikeDeclaration) === owner) {
            assignments.push(parent.getRight());
          } else unsupported = true;
        }
      });
      // Union direct assignments across branches, without guessing mutation
      // order, compound assignment, or writes through a nested function.
      if (assignments.length && !unsupported) return [...new Set(assignments.flatMap(follow))];
    }
  }
  if (Node.isTemplateExpression(node)) {
    let result = [node.getHead().getLiteralText()];
    for (const span of node.getTemplateSpans()) {
      result = combine(result, follow(span.getExpression())).map((text) => text + span.getLiteral().getLiteralText());
    }
    return result;
  }
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    return combine(follow(node.getLeft()), follow(node.getRight()));
  }
  if (Node.isCallExpression(node)) {
    const expression = node.getExpression();
    const functions = callables(expression, bindings);
    if (functions.length) return [...new Set(functions.flatMap((fn) => {
      const bound = bindArguments(fn, node.getArguments(), bindings);
      const expressions = returns(fn);
      return expressions.length ? expressions.flatMap((value) => sqlTexts(value, new Set(seen), bound, unresolved)) : unknown();
    }))];
    if (Node.isPropertyAccessExpression(expression) && expression.getName() === "join") {
      const receiver = expression.getExpression();
      const separator = node.getArguments().length ? literal(node.getArguments()[0]) : ",";
      if (separator === undefined) return unknown();
      const arrays = values(receiver, new Set(), bindings);
      const pushed = pushedBefore(receiver, node);
      return arrays.flatMap((array) => {
        if (Node.isCallExpression(array)) {
          // Helpers often return an array of clauses to join at the call site.
          const functions = callables(array.getExpression(), bindings);
          if (functions.length) return functions.flatMap((fn) => {
            const bound = bindArguments(fn, array.getArguments(), bindings);
            return returns(fn).flatMap((value) => joinReturned(value, bound));
          });
          const method = array.getExpression();
          if (Node.isPropertyAccessExpression(method)) {
            const isMap = method.getName() === "map";
            const isFrom = method.getText() === "Array.from";
            const callback = array.getArguments()[isFrom ? 1 : 0];
            if ((isMap || isFrom) && callback) {
              const functions = callables(callback);
              const sources = isMap ? values(method.getExpression(), new Set(), bindings) : [];
              const items = sources.flatMap((source) => Node.isArrayLiteralExpression(source) ? arrayElements(source, new Set(), bindings) : []);
              // For a runtime-length list, one representative callback result
              // suffices when its SQL structure is independent of the item.
              const groups = items.length ? items : [undefined];
              return groups.reduce<string[]>((result, item, i) => {
                const fragments = functions.flatMap((fn) => {
                  const bound = bindArguments(fn, item ? [item] : [], bindings);
                  return returns(fn).flatMap((value) => sqlTexts(value, new Set(seen), bound, unresolved));
                });
                return combine(result, fragments.length ? fragments : [DYNAMIC], i ? separator : "");
              }, [""]);
            }
          }
        }
        if (!Node.isArrayLiteralExpression(array)) { unresolved.add(array); return [DYNAMIC]; }
        const elements = [...arrayElements(array, new Set(), bindings), ...pushed];
        // Include every conditional push: these are possible accesses across executions.
        return elements.reduce<string[]>((result, element, i) =>
          combine(result, follow(element), i ? separator : ""), [""]);
      });

      function joinReturned(value: Node, bound: Bindings): string[] {
        return values(value, new Set(), bound).flatMap((array) => {
          if (!Node.isArrayLiteralExpression(array)) { unresolved.add(value); return [DYNAMIC]; }
          // Include pushes in the helper before its return, just like local joins.
          const elements = [...arrayElements(array, new Set(), bound), ...pushedBefore(value, value)];
          return elements.reduce<string[]>((result, element, i) =>
            combine(result, sqlTexts(element, new Set(seen), bound, unresolved), i ? separator! : ""), [""]);
        });
      }
    }
    if (Node.isPropertyAccessExpression(expression) && expression.getName() === "replace") {
      const [search, replacement] = node.getArguments();
      const needle = literal(search);
      if (needle !== undefined && replacement) return follow(expression.getExpression()).flatMap((text) =>
        follow(replacement).map((value) => text.replace(needle, () => value)));
    }
  }
  return stringValues(node, new Set(), bindings).map((value) => {
    if (value !== undefined) return value;
    unresolved.add(node);
    return DYNAMIC;
  });
}
