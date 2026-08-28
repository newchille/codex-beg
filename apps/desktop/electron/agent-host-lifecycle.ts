export function isAgentHostPortConflict(message: string): boolean {
  return /\bEADDRINUSE\b/.test(message) && /\b43123\b/.test(message);
}
