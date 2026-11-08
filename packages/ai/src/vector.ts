/** Cosine similarity of two vectors; 0 when either is a zero vector. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a[i] as number;
		const y = b[i] as number;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}
