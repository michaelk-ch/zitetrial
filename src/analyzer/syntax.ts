import { Node, SyntaxKind } from "ts-morph";

export type Bindings = Map<Node, Node[]>;

export function bindArguments(fn: Node, args: Node[], bindings: Bindings): Bindings {
  const bound = new Map(bindings);
  if (Node.isFunctionLikeDeclaration(fn)) fn.getParameters().forEach((parameter, index) => {
    const argument = args[index] ?? parameter.getInitializer();
    if (argument) bound.set(parameter, values(argument, new Set(), bindings));
  });
  return bound;
}

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
    const targets = node.getValueSymbol()?.getDeclarations() ?? [];
    const value = targets.map(initializer).find(Boolean);
    if (value) return value;
    const target = targets.find((target) => Node.isParameterDeclaration(target) || Node.isVariableDeclaration(target) || Node.isBindingElement(target));
    return target?.getNameNode();
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
export function values(node: Node, seen = new Set<Node>(), bindings: Bindings = new Map()): Node[] {
  node = unwrap(node);
  if (seen.has(node)) return [node];
  seen.add(node);
  const follow = (value: Node) => values(value, new Set(seen), bindings);
  if (Node.isConditionalExpression(node)) return [...follow(node.getWhenTrue()), ...follow(node.getWhenFalse())];
  if (Node.isBinaryExpression(node) && [SyntaxKind.QuestionQuestionToken, SyntaxKind.BarBarToken].includes(node.getOperatorToken().getKind())) {
    return [...follow(node.getLeft()), ...follow(node.getRight())];
  }
  if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
    const keys = Node.isPropertyAccessExpression(node) ? [node.getName()] : stringValues(node.getArgumentExpression(), new Set(seen), bindings);
    const found = follow(node.getExpression()).flatMap((base) => {
      if (Node.isObjectLiteralExpression(base)) {
        const members = keys.includes(undefined) ? base.getProperties() : keys.flatMap((key) => base.getProperty((member) => {
          if (Node.isSpreadAssignment(member)) return false;
          const name = member.getNameNode();
          return (Node.isStringLiteral(name) ? name.getLiteralText() : member.getName()) === key;
        }) ?? []);
        return members.flatMap((member) => {
          const value = Node.isMethodDeclaration(member) ? member : initializer(member);
          return value ? follow(value) : [];
        });
      }
      if (Node.isArrayLiteralExpression(base)) {
        const elements = arrayElements(base, new Set(seen), bindings);
        const selected = keys.includes(undefined) ? elements : keys.flatMap((key) => elements[Number(key)] ?? []);
        return selected.flatMap(follow);
      }
      if (Node.isNewExpression(base)) {
        return declarations(base.getExpression()).flatMap((declaration) => Node.isClassDeclaration(declaration)
          ? keys.flatMap((key) => key ? declaration.getInstanceMethod(key) ?? [] : []) : []);
      }
      return [];
    });
    if (found.length) return [...new Set(found)];
  }
  // Source-owned, argument-free registries (for example a demo cleanup plan).
  if (Node.isCallExpression(node) && !node.getArguments().length) {
    const found = follow(node.getExpression()).flatMap((value) =>
      (bodyOf(value) ? [value] : declarations(value)).flatMap((fn) =>
        Node.isFunctionLikeDeclaration(fn) && !fn.getParameters().length ? returns(fn).flatMap(follow) : []));
    if (found.length) return [...new Set(found)];
  }
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    const found = declarations(node).flatMap((declaration) => {
      const bound = bindings.get(declaration);
      if (bound) return bound.flatMap(follow);
      if (Node.isBindingElement(declaration)) {
        const pattern = declaration.getParent();
        const owner = pattern.getParent();
        if (!owner) return [];
        const sources = bindings.get(owner) ?? (initializer(owner) ? follow(initializer(owner)!) : iterationValues(owner));
        return sources.flatMap((source) => {
          if (Node.isArrayBindingPattern(pattern) && Node.isArrayLiteralExpression(source)) {
            const item = arrayElements(source, new Set(seen), bindings)[pattern.getElements().indexOf(declaration)];
            return item ? follow(item) : [];
          }
          if (Node.isObjectBindingPattern(pattern)) {
            const item = property(source, declaration.getPropertyNameNode()?.getText() ?? declaration.getName());
            return item ? follow(item) : [];
          }
          return [];
        });
      }
      const value = initializer(declaration);
      if (value) return follow(value);
      // for (const phase of PHASES) is equivalent to an unknown array index.
      return iterationValues(declaration);
    });
    if (found.length) return [...new Set(found)];
  }
  return [node];

  function iterationValues(declaration: Node): Node[] {
    const loop = declaration.getParent()?.getParent();
    if (!Node.isVariableDeclaration(declaration) || !Node.isForOfStatement(loop)) return [];
    return follow(loop.getExpression()).flatMap((array) =>
      Node.isArrayLiteralExpression(array) ? arrayElements(array, new Set(seen), bindings).flatMap(follow) : []);
  }
}

export function arrayElements(node: Node, seen = new Set<Node>(), bindings: Bindings = new Map()): Node[] {
  if (!Node.isArrayLiteralExpression(node)) return [node];
  return node.getElements().flatMap((element) => Node.isSpreadElement(element)
    ? values(element.getExpression(), new Set(seen), bindings).flatMap((value) =>
      seen.has(value) ? [value] : arrayElements(value, new Set([...seen, value]), bindings))
    : [element]);
}

/** TypeScript supplies finite key unions, including narrowing inside branches. */
export function stringValues(node: Node | undefined, seen = new Set<Node>(), bindings: Bindings = new Map()): (string | undefined)[] {
  if (!node) return [undefined];
  node = unwrap(node); // Ignore casts applied only at the access site.
  const type = node.getType();
  const types = type.isUnion() ? type.getUnionTypes() : [type];
  if (types.every((type) => type.isStringLiteral())) return types.map((type) => String(type.getLiteralValue()));
  return [...new Set(values(node, seen, bindings).map((value) => {
    if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) return value.getLiteralText();
    if (Node.isNumericLiteral(value)) return value.getText();
  }))];
}

export function callables(node: Node, bindings: Bindings = new Map()): Node[] {
  return [...new Set(values(node, new Set(), bindings).flatMap((value) =>
    bodyOf(value) ? [value] : declarations(value).filter((declaration) => bodyOf(declaration))))];
}

export function callable(node: Node): Node | undefined {
  return callables(node)[0];
}

export function returns(fn: Node): Node[] {
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
