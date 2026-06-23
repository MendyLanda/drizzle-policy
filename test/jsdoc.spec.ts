import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import ts from 'typescript';

const sourceRoot = join(process.cwd(), 'src');

describe('JSDoc coverage', () => {
  test('top-level declarations and interface members are documented', () => {
    const missing: string[] = [];

    for (const filePath of listTypeScriptFiles(sourceRoot)) {
      const source = ts.createSourceFile(
        filePath,
        readFileSync(filePath, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );

      for (const statement of source.statements) {
        if (!isDocumentedDeclaration(statement)) {
          continue;
        }

        if (!hasJSDoc(statement, source)) {
          missing.push(formatNode(source, statement));
        }

        if (ts.isInterfaceDeclaration(statement)) {
          for (const member of statement.members) {
            if (!hasJSDoc(member, source)) {
              missing.push(
                `${formatNode(source, statement)}.${memberName(member)}`
              );
            }
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

const listTypeScriptFiles = (directory: string): string[] => {
  const entries = readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return listTypeScriptFiles(path);
    }

    return path.endsWith('.ts') ? [path] : [];
  });

  return entries.filter(path => !basename(path).endsWith('.d.ts')).sort();
};

const isDocumentedDeclaration = (
  statement: ts.Statement
): statement is ts.DeclarationStatement => {
  return (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isVariableStatement(statement)
  );
};

const hasJSDoc = (node: ts.Node, source: ts.SourceFile): boolean => {
  const leading = source.text.slice(node.getFullStart(), node.getStart(source));
  return /\/\*\*[\s\S]*?\*\/\s*$/.test(leading);
};

const formatNode = (source: ts.SourceFile, node: ts.Node): string => {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(sourceRoot, source.fileName)}:${line + 1} ${nodeName(node)}`;
};

const nodeName = (node: ts.Node): string => {
  const maybeNamed = node as { readonly name?: ts.Node };
  if (maybeNamed.name && ts.isIdentifier(maybeNamed.name)) {
    return maybeNamed.name.text;
  }

  return ts.SyntaxKind[node.kind];
};

const memberName = (member: ts.TypeElement): string => {
  const maybeNamed = member as { readonly name?: ts.Node };
  if (maybeNamed.name) {
    return maybeNamed.name.getText();
  }

  return ts.SyntaxKind[member.kind];
};
