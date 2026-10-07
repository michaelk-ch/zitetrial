import { Node, SyntaxKind } from "ts-morph";

export function unwrap(node: Node): Node {
  while (Node.isAsExpression(node) || Node.isTypeAssertion(node) ||
    Node.isParenthesizedExpression(node) || Node.isNonNullExpression(node) ||
    Node.isAwaitExpression(node) || Node.isSatisfiesExpression(node)) {
    node = node.getExpression();
  }
  return node;
}

export function declarations(node: Node): Node[] {
  const symbol = node.getSymbol();
  return (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
}

export function initializer(node: Node): Node | undefined {
  if (Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node) ||
    Node.isParameterDeclaration(node)) return node.getInitializer();
  if (Node.isShorthandPropertyAssignment(node)) {
    return node.getValueSymbol()?.getDeclarations().map(initializer).find(Boolean);
  }
}

export function resolve(node: Node, seen = new Set<Node>()): Node {
  node = unwrap(node);
  if (seen.has(node)) return node;
  seen.add(node);
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    for (const declaration of declarations(node)) {
      const value = initializer(declaration);
      if (value) return resolve(value, seen);
    }
  }
  return node;
}

export function property(node: Node | undefined, name: string): Node | undefined {
  if (!node) return;
  node = resolve(node);
  if (!Node.isObjectLiteralExpression(node)) return;
  const member = node.getProperty(name);
  return member && (Node.isMethodDeclaration(member) ? member : initializer(member));
}

export function bodyOf(node: Node): Node | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) || Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) return node.getBody();
}

export function callable(node: Node): Node | undefined {
  node = resolve(node);
  if (bodyOf(node)) return node;
  return declarations(node).find((declaration) => bodyOf(declaration));
}

function returns(fn: Node): Node[] {
  const body = bodyOf(fn);
  if (!body) return [];
  if (!Node.isBlock(body)) return [body];
  const values: Node[] = [];
  body.forEachDescendant((node, traversal) => {
    if (Node.isFunctionLikeDeclaration(node)) traversal.skip();
    else if (Node.isReturnStatement(node) && node.getExpression()) values.push(node.getExpression()!);
  });
  return values;
}

/** Trace an expression to its SDK import, including aliases and client factories. */
export type Origin = { module: string; members: string[]; instance: boolean };

export function origin(node: Node, seen = new Set<Node>()): Origin | undefined {
  node = unwrap(node);
  if (seen.has(node)) return;
  seen.add(node);
  if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
    const base = origin(node.getExpression(), seen);
    const key = Node.isPropertyAccessExpression(node) ? node.getName() : literal(node.getArgumentExpression());
    return base && { ...base, members: [...base.members, key ?? "<dynamic>"] };
  }
  if (Node.isNewExpression(node)) {
    const base = origin(node.getExpression(), seen);
    return base && { ...base, instance: true };
  }
  if (Node.isCallExpression(node)) {
    const fn = callable(node.getExpression());
    if (fn) {
      for (const value of returns(fn)) {
        const base = origin(value, new Set(seen));
        if (base) return base;
      }
    }
    return;
  }
  if (Node.isConditionalExpression(node)) {
    return origin(node.getWhenTrue(), new Set(seen)) ?? origin(node.getWhenFalse(), seen);
  }
  if (!Node.isIdentifier(node)) return;
  for (const declaration of node.getSymbol()?.getDeclarations() ?? []) {
    const imp = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (!imp) continue;
    const specifier = imp.getModuleSpecifierValue();
    if (specifier.startsWith(".") || specifier.startsWith("@project/") || specifier.startsWith("@/")) continue;
    const name = Node.isImportSpecifier(declaration) ? declaration.getName() :
      Node.isNamespaceImport(declaration) ? "*" : "default";
    return { module: specifier, members: [name], instance: false };
  }
  for (const declaration of declarations(node)) {
    const value = initializer(declaration);
    if (value) {
      const base = origin(value, new Set(seen));
      if (base) return base;
    }
  }
}

export function literal(node: Node | undefined): string | undefined {
  if (!node) return;
  node = resolve(node);
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isNumericLiteral(node)) return node.getText();
}

export const DYNAMIC = "__zite_dynamic__";

/** Resolve literal SQL fragments without evaluating repository code. */
export function sqlText(node: Node | undefined, seen = new Set<Node>()): string {
  if (!node) return DYNAMIC;
  node = resolve(node);
  if (seen.has(node)) return DYNAMIC;
  seen.add(node);
  const text = literal(node);
  if (text !== undefined) return text;
  if (Node.isTemplateExpression(node)) {
    return node.getHead().getLiteralText() + node.getTemplateSpans().map((span) =>
      sqlText(span.getExpression(), new Set(seen)) + span.getLiteral().getLiteralText()).join("");
  }
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    return sqlText(node.getLeft(), new Set(seen)) + sqlText(node.getRight(), seen);
  }
  return DYNAMIC;
}
