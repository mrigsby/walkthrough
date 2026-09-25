// Makes a short, safe name for files and folders, like "add-to-cart".
export function slug(text: string, max: number, fallback: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max) || fallback
  );
}
