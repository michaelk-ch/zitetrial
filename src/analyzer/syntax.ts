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
  const parent = node.getParent();
  if (Node.isVariableDeclaration(node) && Node.isVariableDeclarationList(parent) && parent.getDeclarationKind() !== "const") return;
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

/** Possible values from source-owned maps and arrays, never from all files/types. */
export function values(node: Node, seen = new Set<Node>()): Node[] {
  node = unwrap(node);
  if (seen.has(node)) return [node];
  seen.add(node);
  const follow = (value: Node) => values(value, new Set(seen));
  if (Node.isConditionalExpression(node)) return [...follow(node.getWhenTrue()), ...follow(node.getWhenFalse())];
  if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
    const keys = Node.isPropertyAccessExpression(node) ? [node.getName()] : stringValues(node.getArgumentExpression(), new Set(seen));
    const found = follow(node.getExpression()).flatMap((base) => {
      if (Node.isObjectLiteralExpression(base)) {
        const members = keys.includes(undefined) ? base.getProperties() : keys.flatMap((key) => base.getProperty(key!) ?? []);
        return members.flatMap((member) => {
          const value = Node.isMethodDeclaration(member) ? member : initializer(member);
          return value ? follow(value) : [];
        });
      }
      if (Node.isArrayLiteralExpression(base)) {
        const elements = arrayElements(base, new Set(seen));
        const selected = keys.includes(undefined) ? elements : keys.flatMap((key) => elements[Number(key)] ?? []);
        return selected.flatMap(follow);
      }
      return [];
    });
    if (found.length) return [...new Set(found)];
  }
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    const found = declarations(node).flatMap((declaration) => {
      const value = initializer(declaration);
      if (value) return follow(value);
      // for (const phase of PHASES) is equivalent to an unknown array index.
      const loop = declaration.getParent()?.getParent();
      if (Node.isVariableDeclaration(declaration) && Node.isForOfStatement(loop)) {
        return follow(loop.getExpression()).flatMap((array) =>
          Node.isArrayLiteralExpression(array) ? arrayElements(array, new Set(seen)).flatMap(follow) : []);
      }
      return [];
    });
    if (found.length) return [...new Set(found)];
  }
  return [node];
}

export function arrayElements(node: Node, seen = new Set<Node>()): Node[] {
  if (!Node.isArrayLiteralExpression(node)) return [node];
  return node.getElements().flatMap((element) => Node.isSpreadElement(element)
    ? values(element.getExpression(), new Set(seen)).flatMap((value) =>
      seen.has(value) ? [value] : arrayElements(value, new Set([...seen, value])))
    : [element]);
}

/** TypeScript supplies finite key unions, including narrowing inside branches. */
export function stringValues(node: Node | undefined, seen = new Set<Node>()): (string | undefined)[] {
  if (!node) return [undefined];
  node = unwrap(node); // Ignore casts applied only at the access site.
  const type = node.getType();
  const types = type.isUnion() ? type.getUnionTypes() : [type];
  if (types.every((type) => type.isStringLiteral())) return types.map((type) => String(type.getLiteralValue()));
  return [...new Set(values(node, seen).map((value) => {
    if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) return value.getLiteralText();
    if (Node.isNumericLiteral(value)) return value.getText();
  }))];
}

export function callables(node: Node): Node[] {
  return [...new Set(values(node).flatMap((value) =>
    bodyOf(value) ? [value] : declarations(value).filter((declaration) => bodyOf(declaration))))];
}

export function callable(node: Node): Node | undefined {
  return callables(node)[0];
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

export function origins(node: Node, seen = new Set<Node>()): Origin[] {
  node = unwrap(node);
  if (seen.has(node)) return [];
  seen.add(node);
  const follow = (value: Node) => origins(value, new Set(seen));
  if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
    const keys = Node.isPropertyAccessExpression(node) ? [node.getName()] : stringValues(node.getArgumentExpression());
    return follow(node.getExpression()).flatMap((base) => keys.map((key) =>
      ({ ...base, members: [...base.members, key ?? "<dynamic>"] })));
  }
  if (Node.isNewExpression(node)) {
    return follow(node.getExpression()).map((base) => ({ ...base, instance: true }));
  }
  if (Node.isCallExpression(node)) {
    return callables(node.getExpression()).flatMap((fn) => returns(fn).flatMap(follow));
  }
  if (Node.isConditionalExpression(node)) {
    return [...follow(node.getWhenTrue()), ...follow(node.getWhenFalse())];
  }
  if (!Node.isIdentifier(node)) return [];
  for (const declaration of node.getSymbol()?.getDeclarations() ?? []) {
    const imp = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (!imp) continue;
    const specifier = imp.getModuleSpecifierValue();
    if (specifier.startsWith(".") || specifier.startsWith("@project/") || specifier.startsWith("@/")) continue;
    const name = Node.isImportSpecifier(declaration) ? declaration.getName() :
      Node.isNamespaceImport(declaration) ? "*" : "default";
    return [{ module: specifier, members: [name], instance: false }];
  }
  return declarations(node).flatMap((declaration) => {
    const value = initializer(declaration);
    return value ? follow(value) : [];
  });
}

export function origin(node: Node): Origin | undefined {
  return origins(node)[0];
}

export function literal(node: Node | undefined): string | undefined {
  if (!node) return;
  node = resolve(node);
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isNumericLiteral(node)) return node.getText();
}

export const DYNAMIC = "__zite_dynamic__";
