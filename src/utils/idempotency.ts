function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)])
    );
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export async function payloadFingerprint(action: string, payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${action}\n${canonicalJson(payload)}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isIdempotencyConflict(
  existingAction: string,
  existingFingerprint: string,
  requestedAction: string,
  requestedFingerprint: string
): boolean {
  return existingAction !== requestedAction || existingFingerprint !== requestedFingerprint;
}
