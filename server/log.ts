let quiet = false;

export function setQuiet(q: boolean): void {
  quiet = q;
}

/** 一行一条的结构化日志，便于事后检索。 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  if (quiet) return;
  const time = new Date().toISOString().slice(11, 23);
  console.log(`${time} ${event} ${JSON.stringify(fields)}`);
}
