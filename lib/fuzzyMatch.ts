/**
 * Fuzzy matching per nomi prodotti.
 * Implementazione Jaro-Winkler similarity con threshold configurabile.
 */

/**
 * Calcola la distanza Jaro tra due stringhe.
 */
function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3
  );
}

/**
 * Calcola la similarity Jaro-Winkler tra due stringhe.
 * Ritorna un valore tra 0 (completamente diverse) e 1 (identiche).
 */
export function jaroWinkler(s1: string, s2: string, prefixScale = 0.1): number {
  const jaroScore = jaro(s1, s2);

  // Calcola prefisso comune (max 4 caratteri)
  let prefix = 0;
  for (let i = 0; i < Math.min(s1.length, s2.length, 4); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaroScore + prefix * prefixScale * (1 - jaroScore);
}

/**
 * Normalizza una stringa per il confronto:
 * - lowercase
 * - rimuove accenti
 * - rimuove punteggiatura extra
 * - trim spazi multipli
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // rimuove accenti
    .replace(/[^a-z0-9\s]/g, " ") // punteggiatura → spazio
    .replace(/\s+/g, " ") // spazi multipli → singolo
    .trim();
}

/**
 * Calcola la similarity tra due nomi prodotto.
 * Normalizza entrambi prima del confronto.
 */
export function productSimilarity(name1: string, name2: string): number {
  const n1 = normalize(name1);
  const n2 = normalize(name2);
  return jaroWinkler(n1, n2);
}

export interface MatchResult {
  productId: string;
  productName: string;
  similarity: number;
}

/**
 * Trova il miglior match per un nome prodotto estratto dal DDT
 * contro l'anagrafica prodotti.
 * Ritorna il match se similarity >= threshold, null altrimenti.
 */
export function findBestMatch(
  extractedName: string,
  products: Array<{ id: string; name: string }>,
  threshold = 0.7
): MatchResult | null {
  let bestMatch: MatchResult | null = null;

  for (const product of products) {
    const sim = productSimilarity(extractedName, product.name);
    if (sim >= threshold && (!bestMatch || sim > bestMatch.similarity)) {
      bestMatch = {
        productId: product.id,
        productName: product.name,
        similarity: sim,
      };
    }
  }

  return bestMatch;
}
