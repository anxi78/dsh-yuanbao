/**
 * `@deepseek-ai/dsh-tools` ships JavaScript type stubs instead of `.d.ts`, so
 * TypeScript cannot infer its surface. Declare only what this plugin imports.
 */
declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(options: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: { schema: Record<string, unknown> };
    execute: (args: never, exec: unknown) => Promise<unknown>;
  }): unknown;
}
