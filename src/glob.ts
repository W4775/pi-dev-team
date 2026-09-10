/** Convert a simple glob (`*`, `**`, `?`) to a RegExp. Paths use `/`. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let re = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        const afterSlash = normalized[i + 2] === "/";
        re += afterSlash ? ".*" : ".*";
        i += afterSlash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("+^$()[]{}|.".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function matchGlob(pattern: string, filePath: string): boolean {
  const path = filePath.replaceAll("\\", "/");
  const pat = pattern.replaceAll("\\", "/");
  if (globToRegExp(pat).test(path)) return true;
  if (!pat.startsWith("**/") && globToRegExp(`**/${pat}`).test(path)) return true;
  return false;
}

export function matchAnyGlob(patterns: string[], filePath: string): boolean {
  return patterns.some((p) => matchGlob(p, filePath));
}
