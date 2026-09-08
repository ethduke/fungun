/** A removed deployment chunk cannot be recovered by retrying the same import. */
export function isOutdatedPage(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading (?:CSS )?chunk .+ failed|Unable to preload CSS/i.test(error.message)
  );
}
