const aliases = {
  "@earendil-works/pi-ai": new URL("./pi-ai.mjs", import.meta.url).href,
  "@earendil-works/pi-coding-agent": new URL("./pi-coding-agent.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const url = aliases[specifier];
  if (url) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}
