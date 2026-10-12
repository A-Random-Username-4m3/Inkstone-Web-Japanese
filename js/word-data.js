export function textValue(value) {
	return String(value || '').trim();
}

export function normalizeJapaneseText(value) {
	return String(value || '').trim().normalize('NFKC');
}

export function rowWritten(row) {
	return normalizeJapaneseText(row?.written);
}

export function rowReading(row) {
	return normalizeJapaneseText(row?.reading);
}


export function normalizeJapaneseForComparison(value) {
	return Array.from(textValue(value).normalize('NFKC').toLowerCase())
		.map((character) => {
			const code = character.codePointAt(0);
			return code >= 0x30a1 && code <= 0x30f6
				? String.fromCodePoint(code - 0x60)
				: character;
		})
		.join('')
		.replace(/[\s・･]/g, '');
}

export function readingRevealsWritten(row) {
	const written = normalizeJapaneseForComparison(rowWritten(row));
	const reading = normalizeJapaneseForComparison(rowReading(row));
	return Boolean(written && reading && written === reading);
}

export function rowPromptReading(row) {
	return readingRevealsWritten(row) ? '' : rowReading(row);
}

export function rowDefinitions(row) {
	if (Array.isArray(row?.definitions)) {
		return [...new Set(row.definitions.map(textValue).filter(Boolean))];
	}
	const definition = textValue(row?.definition);
	return definition ? [definition] : [];
}

export function rowDefinition(row) {
	return rowDefinitions(row).join('; ');
}

export function rowCanonicalWord(row) {
	return textValue(row?.studyId) || rowWritten(row);
}

export function rowWords(row) {
	const written = rowWritten(row);
	return written ? [written] : [];
}
