export function expectedPathMatches(pattern: string, path: string): boolean {
  if (pattern.split("/", 1)[0]?.includes("*")) return false;
  const source = pattern.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&")).join("[^/]*");
  return new RegExp(`^${source}$`, "u").test(path);
}
