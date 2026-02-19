export function normalize(text) {
    return text
        .toLowerCase()
        .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s'.\-]/g, '')
        .trim();
}
//# sourceMappingURL=normalize.js.map