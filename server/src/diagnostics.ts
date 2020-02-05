import * as path from "path";

import {
  IConnection,
  Range,
  Diagnostic,
  DiagnosticSeverity,
  CodeAction,
  CodeActionKind,
  Command,
  TextDocuments
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as ts from "typescript";
import { URI } from "vscode-uri";

import { Bridge } from "./bridge";
import { deno } from "./deno";

interface Fix {
  title: string;
  command: string;
}

enum DiagnosticCode {
  InvalidModule = 1001,
  MissingExtension = 1002,
  PreferHTTPS = 1003,
  LocalModuleNotExist = 1004,
  RemoteModuleNotExist = 1005
}

const FixItems: { [code: number]: Fix } = {
  [DiagnosticCode.MissingExtension]: {
    title: "Add `.ts` extension.",
    command: "deno._add_missing_extension"
  },
  [DiagnosticCode.PreferHTTPS]: {
    title: "Use HTTPS module.",
    command: "deno._use_https_module"
  },
  [DiagnosticCode.LocalModuleNotExist]: {
    title: "Create module.",
    command: "deno._create_local_module"
  },
  [DiagnosticCode.RemoteModuleNotExist]: {
    title: "Fetch module.",
    command: "deno._fetch_remote_module"
  }
};

export class Diagnostics {
  constructor(
    private name: string,
    private connection: IConnection,
    private bridge: Bridge,
    private documents: TextDocuments<TextDocument>
  ) {
    connection.onCodeAction(async params => {
      const { context, textDocument } = params;
      const { diagnostics } = context;
      const denoDiagnostics = diagnostics.filter(v => v.source === this.name);

      if (!denoDiagnostics.length) {
        return;
      }

      const actions: CodeAction[] = denoDiagnostics
        .map(v => {
          const code = v.code;

          const fixItem: Fix = FixItems[code];

          if (!fixItem) {
            return;
          }

          const action = CodeAction.create(
            `${fixItem.title} (${this.name})`,
            Command.create(
              fixItem.title,
              fixItem.command,
              // argument
              textDocument.uri,
              {
                start: {
                  line: v.range.start.line,
                  character: v.range.start.character + 1
                },
                end: {
                  line: v.range.end.line,
                  character: v.range.end.character - 1
                }
              }
            ),
            CodeActionKind.QuickFix
          );

          return action;
        })
        .filter(v => v);

      return actions;
    });

    connection.onNotification("updateDiagnostic", (uri: string) => {
      const document = this.documents.get(uri);
      document && this.diagnosis(document);
    });
  }
  async generate(document: TextDocument): Promise<Diagnostic[]> {
    if (!["typescript", "typescriptreact"].includes(document.languageId)) {
      return [];
    }

    // get workspace config
    const config = await this.bridge.getWorkspaceConfig(document.uri);

    if (!config.enable) {
      return [];
    }

    let sourceFile;
    try {
      // Parse a file
      sourceFile = ts.createSourceFile(
        document.uri.toString(),
        document.getText(),
        ts.ScriptTarget.ESNext,
        false,
        ts.ScriptKind.TSX
      );
    } catch (err) {
      return [];
    }

    const moduleNodes: ts.LiteralLikeNode[] = [];

    function delint(SourceFile: ts.SourceFile) {
      delintNode(SourceFile);

      function delintNode(node: ts.Node) {
        let moduleNode: ts.LiteralLikeNode | null = null;
        switch (node.kind) {
          // import('xxx')
          case ts.SyntaxKind.CallExpression:
            const expression = (node as ts.CallExpression).expression;
            const args = (node as ts.CallExpression).arguments;
            const isDynamicImport =
              expression?.kind === ts.SyntaxKind.ImportKeyword;
            if (isDynamicImport) {
              const argv = args[0] as ts.StringLiteral;

              if (argv && ts.isStringLiteral(argv)) {
                moduleNode = argv;
              }
            }
            break;
          // import ts = require('typescript')
          case ts.SyntaxKind.ImportEqualsDeclaration:
            const ref = (node as ts.ImportEqualsDeclaration)
              .moduleReference as ts.ExternalModuleReference;

            if (ref.expression && ts.isStringLiteral(ref.expression)) {
              moduleNode = ref.expression;
            }
            break;
          // import * as from 'xx'
          // import 'xx'
          // import xx from 'xx'
          case ts.SyntaxKind.ImportDeclaration:
            const spec = (node as ts.ImportDeclaration).moduleSpecifier;
            if (spec && ts.isStringLiteral(spec)) {
              moduleNode = spec;
            }
            break;
          // export { window } from "xxx";
          // export * from "xxx";
          case ts.SyntaxKind.ExportDeclaration:
            const exportSpec = (node as ts.ExportDeclaration).moduleSpecifier;
            if (exportSpec && ts.isStringLiteral(exportSpec)) {
              moduleNode = exportSpec;
            }
            break;
        }

        if (moduleNode) {
          moduleNodes.push(moduleNode);
        }

        ts.forEachChild(node, delintNode);
      }
    }

    // delint it
    delint(sourceFile);

    const validExtensionNameMap = {
      ".ts": true,
      ".tsx": true,
      ".js": true,
      ".jsx": true,
      ".json": true,
      ".wasm": true
    };

    const dir = path.dirname(URI.parse(document.uri).path);
    const diagnosticsForThisDocument = [];

    for (const moduleNode of moduleNodes) {
      const numberOfSpaces = Math.abs(
        // why plus 2?
        // because `moduleNode.text` only contain the plaintext without two quotes
        moduleNode.end - moduleNode.pos - (moduleNode.text.length + 2)
      );

      const range = Range.create(
        document.positionAt(moduleNode.pos + numberOfSpaces),
        document.positionAt(moduleNode.end)
      );

      const isRelativeModule = /^\..+/.test(moduleNode.text);
      const isRemoteModule = /^https?:\/\/.*/.test(moduleNode.text);

      if (!isRelativeModule && !isRemoteModule) {
        diagnosticsForThisDocument.push(
          Diagnostic.create(
            range,
            `Deno only supports importting \`relative/HTTP\` module.`,
            DiagnosticSeverity.Error,
            DiagnosticCode.InvalidModule,
            this.name
          )
        );
      }

      {
        const [extensionName] = moduleNode.text.match(/\.[a-zA-Z\d]+$/) || [];

        if (!validExtensionNameMap[extensionName]) {
          diagnosticsForThisDocument.push(
            Diagnostic.create(
              range,
              `Please specify valid extension name of the imported module.`,
              DiagnosticSeverity.Error,
              DiagnosticCode.MissingExtension,
              this.name
            )
          );
        }
      }

      if (isRemoteModule) {
        if (/^https:\/\//.test(moduleNode.text) === false) {
          diagnosticsForThisDocument.push(
            Diagnostic.create(
              range,
              `For security, we recommend using the HTTPS module.`,
              DiagnosticSeverity.Warning,
              DiagnosticCode.PreferHTTPS,
              this.name
            )
          );
        }
      }

      const module = await deno.resolveModule(dir, moduleNode.text);

      if (!ts.sys.fileExists(module.filepath)) {
        diagnosticsForThisDocument.push(
          Diagnostic.create(
            range,
            `Cannot found module \`${module.raw}\`.`,
            DiagnosticSeverity.Error,
            module.remote
              ? DiagnosticCode.RemoteModuleNotExist
              : DiagnosticCode.LocalModuleNotExist,
            this.name
          )
        );
      }
    }

    return diagnosticsForThisDocument;
  }
  async diagnosis(document: TextDocument): Promise<void> {
    this.connection.sendDiagnostics({
      uri: document.uri,
      version: document.version,
      diagnostics: await this.generate(document)
    });
  }
}
