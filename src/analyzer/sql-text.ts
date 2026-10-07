import { Node, SyntaxKind } from "ts-morph";
import { arrayElements, bodyOf, declarations, DYNAMIC, literal, stringValues, unwrap, values } from "./syntax.ts";

// Bound combinations of independent choices. A sentinel keeps truncation visible.
const MAX_VARIANTS = 128;
function combine(left: string[], right: string[], separator = ""): string[] {
  const result = new Set<string>();
  for (const a of left) for (const b of right) {
    result.add(a + separator + b);
    if (result.size > MAX_VARIANTS) return [...result].slice(0, MAX_VARIANTS).concat(DYNAMIC);
  }
  return [...result];
}

/** Recover possible queries from constants, lookup maps, templates, and array joins. */
export function sqlTexts(node: Node | undefined, seen = new Set<Node>()): string[] {
  if (!node) return [DYNAMIC];
  node = unwrap(node);
  if (seen.has(node)) return [DYNAMIC];
  seen.add(node);
  const follow = (value: Node) => sqlTexts(value, new Set(seen));
  const candidates = values(node);
  if (candidates.length !== 1 || candidates[0] !== node) return [...new Set(candidates.flatMap(follow))];
  const text = literal(node);
  if (text !== undefined) return [text];
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
    if (Node.isPropertyAccessExpression(expression) && expression.getName() === "join") {
      const receiver = expression.getExpression();
      const separator = node.getArguments().length ? literal(node.getArguments()[0]) : ",";
      if (separator === undefined) return [DYNAMIC];
      const arrays = values(receiver);
      const pushed: Node[] = [];
      const variable = declarations(receiver).find(Node.isVariableDeclaration);
      const owner = variable?.getFirstAncestor(Node.isFunctionLikeDeclaration);
      const body = owner && bodyOf(owner);
      body?.forEachDescendant((child, traversal) => {
        if (Node.isFunctionLikeDeclaration(child)) {
          traversal.skip();
          return;
        }
        if (!Node.isCallExpression(child) || child.getStart() >= node.getStart()) return;
        const call = child.getExpression();
        if (Node.isPropertyAccessExpression(call) && call.getName() === "push" &&
          declarations(call.getExpression()).includes(variable!)) pushed.push(...child.getArguments());
      });
      return arrays.flatMap((array) => {
        if (!Node.isArrayLiteralExpression(array)) return [DYNAMIC];
        const elements = [...arrayElements(array), ...pushed];
        // Include every conditional push: these are possible accesses across executions.
        return elements.reduce<string[]>((result, element, i) =>
          combine(result, follow(element), i ? separator : ""), [""]);
      });
    }
  }
  return stringValues(node).map((value) => value ?? DYNAMIC);
}
