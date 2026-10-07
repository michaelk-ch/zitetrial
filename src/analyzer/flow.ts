import { Node, SyntaxKind } from "ts-morph";
import { bodyOf, callables, constant, isAssigned } from "./syntax.ts";
import type { Bindings, Constant } from "./syntax.ts";

/** Known scalar leaves only. Missing paths remain unknown. */
export function literalFacts(value: Constant | undefined, prefix: string, out: Record<string, string | number | boolean | null> = {}) {
  if (value === undefined) return out;
  if (value === null || typeof value !== "object") out[prefix] = value;
  else for (const [key, child] of Object.entries(value)) literalFacts(child, `${prefix}.${key}`, out);
  return out;
}

function lexicalOwners(node: Node): Node[] {
  return [node, ...node.getAncestors()].filter(Node.isFunctionLikeDeclaration);
}

/** Carry literals and callbacks, not arbitrary caller expressions or runtime data. */
export function contextBindings(fn: Node, args: Node[], inherited: Bindings, unknownArguments = false): Bindings {
  const bound: Bindings = new Map();
  bound.constants = new Map();
  const callbacks = args.flatMap((argument) => callables(argument, inherited));
  const owners = new Set([fn, ...lexicalOwners(fn), ...callbacks.flatMap(lexicalOwners)]);
  const captured = (declaration: Node) => owners.has(declaration.getFirstAncestor(Node.isFunctionLikeDeclaration)!);
  for (const [declaration, value] of inherited.constants ?? []) if (captured(declaration)) bound.constants.set(declaration, value);
  for (const [declaration, value] of inherited) if (captured(declaration)) bound.set(declaration, value);
  if (Node.isFunctionLikeDeclaration(fn)) fn.getParameters().forEach((parameter, index) => {
    bound.constants!.delete(parameter);
    bound.delete(parameter);
    const spread = args.findIndex(Node.isSpreadElement);
    if (unknownArguments || (spread >= 0 && index >= spread) || isAssigned(parameter)) return;
    const argument = args[index] ?? parameter.getInitializer();
    if (!argument) return;
    const source = args[index] ? inherited : bound;
    const value = constant(argument, source);
    if (value !== undefined) bound.constants!.set(parameter, value);
    const functions = callables(argument, source);
    if (functions.length) bound.set(parameter, functions);
  });
  return bound;
}

const NEXT = 1, RETURN = 2, BREAK = 4, CONTINUE = 8;

/** Prune only proven branches; unknown conditions keep both paths. */
export function walkBody(fn: Node, bindings: Bindings, onCall: (node: import("ts-morph").CallExpression) => void) {
  const body = bodyOf(fn);
  if (body) visit(body);

  function statements(nodes: Node[]): number {
    let flow = NEXT;
    for (const node of nodes) {
      if (!(flow & NEXT)) break;
      flow = (flow & ~NEXT) | visit(node);
    }
    return flow;
  }

  function visit(node: Node): number {
    if (Node.isFunctionLikeDeclaration(node)) return NEXT;
    if (Node.isBlock(node)) return statements(node.getStatements());
    if (Node.isIfStatement(node) || Node.isConditionalExpression(node)) {
      const condition = Node.isIfStatement(node) ? node.getExpression() : node.getCondition();
      visit(condition);
      const yes = Node.isIfStatement(node) ? node.getThenStatement() : node.getWhenTrue();
      const no = Node.isIfStatement(node) ? node.getElseStatement() : node.getWhenFalse();
      const value = constant(condition, bindings);
      if (value !== undefined) return value ? visit(yes) : no ? visit(no) : NEXT;
      return visit(yes) | (no ? visit(no) : NEXT);
    }
    if (Node.isSwitchStatement(node)) {
      visit(node.getExpression());
      const value = constant(node.getExpression(), bindings);
      const clauses = node.getClauses();
      for (const clause of clauses) if (Node.isCaseClause(clause)) visit(clause.getExpression());
      const labels = clauses.map((clause) => Node.isCaseClause(clause) ? constant(clause.getExpression(), bindings) : undefined);
      const fallback = clauses.findIndex(Node.isDefaultClause);
      let starts = clauses.map((_, i) => i);
      const scalar = (value: Constant | undefined) => value !== undefined && (value === null || typeof value !== "object");
      const known = scalar(value) && clauses.every((clause, i) => Node.isDefaultClause(clause) || scalar(labels[i]));
      if (known) {
        const match = clauses.findIndex((clause, i) => Node.isCaseClause(clause) && labels[i] === value);
        starts = match >= 0 ? [match] : fallback >= 0 ? [fallback] : [];
      }
      let flow = known ? (starts.length ? 0 : NEXT) : fallback < 0 ? NEXT : 0;
      for (const start of starts) {
        let branch = NEXT;
        for (const clause of clauses.slice(start)) {
          if (!(branch & NEXT)) break;
          branch = (branch & ~NEXT) | statements(clause.getStatements());
        }
        flow |= (branch & ~BREAK) | (branch & BREAK ? NEXT : 0);
      }
      return flow;
    }
    if (Node.isBinaryExpression(node)) {
      const op = node.getOperatorToken().getKind();
      if ([SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken].includes(op)) {
        visit(node.getLeft());
        const left = constant(node.getLeft(), bindings);
        if (left === undefined || (op === SyntaxKind.AmpersandAmpersandToken ? Boolean(left) :
          op === SyntaxKind.BarBarToken ? !left : left === null)) visit(node.getRight());
        return NEXT;
      }
    }
    if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) {
      const expression = node.getExpression();
      if (expression) visit(expression);
      return RETURN;
    }
    if (Node.isBreakStatement(node)) return BREAK;
    if (Node.isContinueStatement(node)) return CONTINUE;
    if (Node.isCallExpression(node)) onCall(node);
    // Loop bodies are conservatively visited once; their returns/breaks do not
    // imply the loop necessarily ran. Conditions and nested calls still count.
    node.forEachChild((child) => { visit(child); });
    return NEXT;
  }
}
