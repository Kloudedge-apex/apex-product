import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

interface GuardedEffect {
  readonly id: string;
  readonly matches: (callee: string, relativeFile: string) => boolean;
}

interface GuardedEffectCall {
  readonly guardId: string;
  readonly callee: string;
  readonly line: number;
  readonly column: number;
  readonly detached: boolean;
}

const PROVIDER_WRITE_TRANSPORT_FILES = new Set([
  "integrations/linkedin/linkedin.service.ts",
  "runtime/tools/hubspot.tool.ts",
  "runtime/tools/send-email.tool.ts",
]);

/**
 * Keep this list deliberately narrow. These are the known provider writers
 * and writer-tracked observability calls in the outreach/evaluator slice; this
 * is not a generic ban on `void`, Prisma writes, timers, or async callbacks.
 */
const GUARDED_EFFECTS: readonly GuardedEffect[] = [
  {
    id: "evidence-ledger-append",
    matches: (callee) =>
      callee.endsWith(".messageSent") ||
      callee.endsWith(".artifactPersisted"),
  },
  {
    id: "langsmith-dataset-or-feedback-write",
    matches: (callee) =>
      [
        ".addRunToDataset",
        ".createDataset",
        ".createExample",
        ".createFeedback",
      ].some((suffix) => callee.endsWith(suffix)),
  },
  {
    id: "langsmith-evaluator-write",
    matches: (callee) =>
      endsWithPath(callee, "runLevelEvaluator.evaluateGraphRun") ||
      endsWithPath(callee, "evaluatorRunner.run"),
  },
  {
    id: "linkedin-provider-send",
    matches: (callee) => endsWithPath(callee, "linkedinService.sendMessage"),
  },
  {
    id: "hubspot-provider-write",
    matches: (callee) =>
      /\.crm\.(contacts|deals|companies)\.basicApi\.(create|update)$/.test(
        callee,
      ) ||
      /(^|\.)hubspotService\.(createContact|updateContact|createDeal|updateDeal|createCompany)$/.test(
        callee,
      ) ||
      callee === "hubspotFetch",
  },
  {
    id: "provider-write-transport",
    matches: (callee, relativeFile) =>
      callee === "withCircuitBreaker" &&
      PROVIDER_WRITE_TRANSPORT_FILES.has(relativeFile),
  },
];

/**
 * Exceptions must identify one exact source location. There are intentionally
 * none today; the cap prevents this guard becoming a broad waiver list.
 */
const ALLOWED_DETACHED_EFFECTS = new Set<string>();
const MAX_ALLOWED_DETACHED_EFFECTS = 2;

describe("external-effect promise settlement", () => {
  it("detects detached guarded calls without rejecting joined calls", () => {
    const source = ts.createSourceFile(
      "fixture.ts",
      `
        async function detached(ledger: any, langsmith: any, linkedinService: any) {
          void ledger.messageSent({});
          langsmith.addRunToDataset("dataset", "run").catch(() => undefined);
          const pending = linkedinService.sendMessage("org", null, {});
        }
        async function joined(ledger: any, langsmith: any, hubspotService: any) {
          await ledger.artifactPersisted({});
          await Promise.all([langsmith.createFeedback({})]);
          return hubspotService.createContact("org", {});
        }
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const violations = scanGuardedEffects(source, "fixture.ts").filter(
      (call) => call.detached,
    );

    expect(violations.map((violation) => violation.guardId)).toEqual([
      "evidence-ledger-append",
      "langsmith-dataset-or-feedback-write",
      "linkedin-provider-send",
    ]);
  });

  it("has no detached known external-effect calls in production API source", () => {
    const sourceRoot = join(process.cwd(), "src");
    const violations: string[] = [];
    const usedAllowlist = new Set<string>();
    const matchedGuardIds = new Set<string>();

    for (const file of productionTypeScriptFiles(sourceRoot)) {
      const relativeFile = relative(sourceRoot, file).replaceAll("\\", "/");
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      for (const violation of scanGuardedEffects(source, relativeFile)) {
        matchedGuardIds.add(violation.guardId);
        if (!violation.detached) continue;
        const location = `${violation.guardId}@${relativeFile}:${violation.line}:${violation.column}`;
        if (ALLOWED_DETACHED_EFFECTS.has(location)) {
          usedAllowlist.add(location);
          continue;
        }
        violations.push(
          `${relativeFile}:${violation.line}:${violation.column} ${violation.guardId} (${violation.callee})`,
        );
      }
    }

    expect(
      ALLOWED_DETACHED_EFFECTS.size,
      "keep detached external-effect exceptions tiny",
    ).toBeLessThanOrEqual(MAX_ALLOWED_DETACHED_EFFECTS);
    expect(
      [...ALLOWED_DETACHED_EFFECTS].filter(
        (exception) => !usedAllowlist.has(exception),
      ),
      "remove stale detached external-effect exceptions",
    ).toEqual([]);
    expect(
      [...matchedGuardIds].sort(),
      "every guarded category must match at least one production call site",
    ).toEqual(GUARDED_EFFECTS.map((guard) => guard.id).sort());
    expect(
      violations,
      "await or return every guarded provider/observability mutation",
    ).toEqual([]);
  }, 15_000);
});

function scanGuardedEffects(
  source: ts.SourceFile,
  relativeFile: string,
): GuardedEffectCall[] {
  const calls: GuardedEffectCall[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = expressionPath(node.expression);
      for (const guard of GUARDED_EFFECTS) {
        if (!guard.matches(callee, relativeFile)) continue;
        const { line, character } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        calls.push({
          guardId: guard.id,
          callee,
          line: line + 1,
          column: character + 1,
          detached: isDetached(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return calls;
}

/**
 * A guarded call is settled only when its promise is awaited or returned at
 * the call site. An expression-bodied callback also returns the promise to its
 * caller. Assigning it to a local without a syntactic join remains a failure:
 * this intentionally avoids pretending to perform whole-program data-flow.
 */
function isDetached(call: ts.CallExpression): boolean {
  let current: ts.Node = call;

  while (current.parent) {
    const parent = current.parent;
    if (ts.isVoidExpression(parent)) return true;
    if (
      ts.isAwaitExpression(parent) ||
      ts.isReturnStatement(parent) ||
      ts.isYieldExpression(parent)
    ) {
      return false;
    }
    if (ts.isArrowFunction(parent) && !ts.isBlock(parent.body)) {
      return false;
    }
    if (ts.isFunctionLike(parent)) return true;
    current = parent;
  }

  return true;
}

function expressionPath(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isParenthesizedExpression(expression)) {
    return expressionPath(expression.expression as ts.LeftHandSideExpression);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return `${expressionPath(expression.expression)}.${expression.name.text}`;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return `${expressionPath(expression.expression)}.${expression.argumentExpression.text}`;
  }
  return expression.getText();
}

function endsWithPath(callee: string, suffix: string): boolean {
  return callee === suffix || callee.endsWith(`.${suffix}`);
}

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") {
        files.push(...productionTypeScriptFiles(absolute));
      }
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      files.push(absolute);
    }
  }
  return files.sort();
}
