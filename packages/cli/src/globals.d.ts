declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(text: string): boolean };
  stderr: { write(text: string): boolean };
  exitCode?: number;
};
