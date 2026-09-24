/**
 * Initials for an avatar: "Alice Andersson" → "AA", "alice" → "AL",
 * "bob@demo" → "BO". Shared by the persona cards and the signed-in user menu
 * so the person you click on the landing page and the identity the header
 * shows after login are drawn the same way.
 */
export function initials(label: string): string {
  const parts = label
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
