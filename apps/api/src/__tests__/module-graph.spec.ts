import { describe, expect, it } from "vitest";
import { AppModule } from "../app.module";

/**
 * Regression: prod incident 2026-06-12 (api rev 0000110 / worker rev 0000059).
 *
 * GmailModule gained `forwardRef(() => OutreachModule)` for DSN auto-suppress,
 * closing the ES-module evaluation cycle integrations.module → gmail.module →
 * outreach.module → integrations.module. Under that cycle, OutreachModule's
 * decorator evaluated while IntegrationsModule's binding was still
 * uninitialized, so Nest saw `imports: [undefined, ...]` and the WHOLE app
 * (api + worker) crash-looped at boot with UndefinedModuleException — while
 * every unit test stayed green, because nothing ever compiled the real module
 * graph from the real entry point.
 *
 * Importing AppModule above reproduces production's evaluation order. The walk
 * below fails with the offending path if ANY module's imports/exports array
 * carries an undefined entry, before a deploy ships it.
 */

type ModuleLike = { name?: string };
type ForwardRefShape = { forwardRef: () => unknown };

const isForwardRef = (x: unknown): x is ForwardRefShape =>
  typeof x === "object" && x !== null && typeof (x as ForwardRefShape).forwardRef === "function";

const labelOf = (x: unknown): string => {
  if (isForwardRef(x)) return `forwardRef(${labelOf(x.forwardRef())})`;
  if (typeof x === "function") return (x as ModuleLike).name ?? "<anonymous>";
  return String(x);
};

describe("module graph integrity (boot regression, 2026-06-12)", () => {
  it("every @Module imports/exports entry reachable from AppModule is defined", () => {
    const offenders: string[] = [];
    const visited = new Set<unknown>();

    const walk = (mod: unknown, path: string[]): void => {
      if (typeof mod !== "function" || visited.has(mod)) return;
      visited.add(mod);
      const here = [...path, labelOf(mod)];

      for (const key of ["imports", "exports"] as const) {
        const entries: unknown[] = Reflect.getMetadata(key, mod) ?? [];
        entries.forEach((entry, i) => {
          if (entry === undefined || entry === null) {
            offenders.push(
              `${here.join(" -> ")} has ${key}[${i}] = ${String(entry)} ` +
                "(circular file-level import evaluated before its binding initialized?)",
            );
            return;
          }
          walk(isForwardRef(entry) ? entry.forwardRef() : entry, here);
        });
      }
    };

    walk(AppModule, []);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
